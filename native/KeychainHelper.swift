import AppKit
import Security
import Foundation

// Passwords only cross the private stdin pipe to the fixed browser worker.
// There is intentionally no command that prints a Keychain secret.
struct Credentials: Codable { var username: String; var password: String }
struct Request: Codable { var service: String; var operation: String; var dates: [String]; var credentials: Credentials? }
let services = ["source", "sugarmate"]
let prefix = "org.ivan.seattle-source-checker."

func output(_ status: String, _ service: String = "") {
    let value = ["status": status, "service": service]
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
}
func query(_ service: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: prefix + service,
     kSecAttrAccount as String: "parent-login"]
}
func read(_ service: String) -> (OSStatus, Credentials?) {
    var q = query(service)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data,
          let credentials = try? JSONDecoder().decode(Credentials.self, from: data) else { return (status, nil) }
    return (status, credentials)
}
func setup(_ service: String) -> Bool {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Save \(service == "source" ? "The Source" : "Sugarmate") login"
    alert.informativeText = "Enter your existing parent account credentials. They will be encrypted in your login Keychain. The school checker can use them to sign in to this service."
    alert.addButton(withTitle: "Save to Keychain")
    alert.addButton(withTitle: "Cancel")
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 340, height: 100))
    let username = NSTextField(frame: NSRect(x: 0, y: 65, width: 340, height: 26))
    username.placeholderString = "Username or email"
    let password = NSSecureTextField(frame: NSRect(x: 0, y: 20, width: 340, height: 26))
    password.placeholderString = "Password"
    view.addSubview(username); view.addSubview(password)
    alert.accessoryView = view
    alert.window.initialFirstResponder = username
    guard alert.runModal() == .alertFirstButtonReturn else { output("cancelled", service); return false }
    guard !username.stringValue.isEmpty, !password.stringValue.isEmpty else { output("empty_credentials", service); return false }
    let credentials = Credentials(username: username.stringValue, password: password.stringValue)
    guard let data = try? JSONEncoder().encode(credentials) else { output("setup_failed", service); return false }
    var q = query(service)
    // Trust the signed native helper, not the node interpreter or all applications.
    var trusted: SecTrustedApplication?
    var access: SecAccess?
    let path = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
    guard SecTrustedApplicationCreateFromPath(path, &trusted) == errSecSuccess,
          let trusted = trusted,
          SecAccessCreate("Seattle school checker \(service)" as CFString, [trusted] as CFArray, &access) == errSecSuccess,
          let access = access else { output("access_setup_failed", service); return false }
    let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccess as String: access]
    let existing = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
    if existing == errSecItemNotFound {
        q.merge(attributes) { _, new in new }
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { output("setup_failed", service); return false }
    } else if existing != errSecSuccess { output("setup_failed", service); return false }
    password.stringValue = ""; username.stringValue = ""
    output("stored", service)
    return true
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 2, services.contains(args[1]) else {
    output("usage: checker setup|status|login|check source|sugarmate [YYYY-MM-DD ...]"); exit(2)
}
let operation = args[0], service = args[1]
if operation == "setup" { exit(setup(service) ? 0 : 3) }
if operation == "status" {
    // Attribute-only lookup does not retrieve the password or trigger access approval.
    var q = query(service); q[kSecReturnAttributes as String] = true
    let status = SecItemCopyMatching(q as CFDictionary, nil)
    output(status == errSecSuccess ? "configured" : "not_configured", service); exit(0)
}
guard ["login", "check"].contains(operation) else { output("unknown_command"); exit(2) }
let dates = Array(args.dropFirst(2))
guard dates.count <= 7, dates.allSatisfy({ $0.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil }) else {
    output("invalid_dates", service); exit(2)
}
let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let root = executable.deletingLastPathComponent().deletingLastPathComponent()
let configURL = root.appendingPathComponent("build/runtime.json")
guard let configData = try? Data(contentsOf: configURL),
      let config = try? JSONSerialization.jsonObject(with: configData) as? [String: String],
      let node = config["node"], node.hasPrefix("/") else { output("build_required", service); exit(2) }
func runWorker(_ credentials: Credentials?) throws -> (Data, Int32) {
let request = Request(service: service, operation: operation, dates: dates, credentials: credentials)
let process = Process()
process.executableURL = URL(fileURLWithPath: node)
process.arguments = [root.appendingPathComponent("src/worker.js").path]
process.currentDirectoryURL = root
// Do not inherit debug flags, NODE_OPTIONS, or environment-based credentials.
var environment: [String: String] = [:]
for key in ["HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "DISPLAY"] {
    if let value = ProcessInfo.processInfo.environment[key] { environment[key] = value }
}
process.environment = environment
let input = Pipe(), out = Pipe()
process.standardInput = input; process.standardOutput = out; process.standardError = FileHandle.nullDevice
    try process.run()
    let data = try JSONEncoder().encode(request)
    input.fileHandleForWriting.write(data)
    try input.fileHandleForWriting.close()
    // Worker outputs are an allowlisted report only. Discard raw browser diagnostics.
    let result = out.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (result, process.terminationStatus)
}
do {
    // Reuse the browser session without accessing Keychain whenever possible.
    var (result, code) = try runWorker(nil)
    if let json = try? JSONSerialization.jsonObject(with: result) as? [String: Any],
       json["status"] as? String == "credentials_required" {
        let (status, credentials) = read(service)
        guard status == errSecSuccess, let credentials = credentials else {
            output(status == errSecItemNotFound ? "setup_required" : "keychain_access_required", service)
            exit(3)
        }
        (result, code) = try runWorker(credentials)
    }
    if let json = try? JSONSerialization.jsonObject(with: result) as? [String: Any],
       json["status"] is String {
        FileHandle.standardOutput.write(result)
    } else { output("worker_failed", service) }
    exit(code)
} catch { output("worker_failed", service); exit(1) }
