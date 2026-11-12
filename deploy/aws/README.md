# AWS deployment for the Source runner

The existing EC2 instance in Oregon starts on weekday afternoons, runs
one [Source check](../../scripts/source-runner/README.md), posts the
result to the [Worker](../../worker/README.md) and powers itself off.
It keeps its Elastic IP so the portal sees the same address each day.
The instance has no inbound rules and nothing calls into it.

| File | Purpose |
| --- | --- |
| `source-runner.yaml` | CloudFormation: the instance role, the start schedule and a safety stop. |
| `install.sh` | Installs Node.js, Chrome, the AWS CLI and this repository on the instance. |
| `source-runner.service` | Runs the check once at boot, then powers off. |
| `run-once.sh` | Reads the settings from Parameter Store and starts the runner. |
| `set-source-credentials.sh` | Prompts for the Source username and password and stores them in Parameter Store. |

## Steps

1. Deploy the Worker first and note its URL and ingest token.
2. Store the settings as `SecureString` parameters in `us-west-2`.
   Enter the values yourself. Keep them out of shell history and chat.
   `sh deploy/aws/set-source-credentials.sh` prompts for the username
   and password and stores those two.

   | Parameter | Value |
   | --- | --- |
   | `/seattle-source-checker/source-username` | The Source parent username. |
   | `/seattle-source-checker/source-password` | The Source parent password. |
   | `/seattle-source-checker/children-json` | The contents of `children.json`. |
   | `/seattle-source-checker/ingest-url` | `https://<worker host>/v1/ingest/source` |
   | `/seattle-source-checker/ingest-token` | The Worker's `INGEST_TOKEN`. |

3. Create the stack and attach the instance profile it outputs. The
   stack creates two IAM roles, so the identity that deploys it needs
   permission to create roles and instance profiles.

   ```sh
   aws cloudformation deploy --region us-west-2 --stack-name source-runner \
     --template-file deploy/aws/source-runner.yaml --capabilities CAPABILITY_IAM \
     --parameter-overrides InstanceId=<instance-id>
   aws ec2 associate-iam-instance-profile --region us-west-2 \
     --instance-id <instance-id> --iam-instance-profile Name=<profile-name>
   ```

4. Start the instance, open a Session Manager shell, and run
   `install.sh` as root with the commit or tag to install.
5. Start the service once and read its one-line result.

   ```sh
   systemctl start source-runner.service
   journalctl -u source-runner.service -n 5
   ```

   Confirm the Worker's `/v1/checks/latest` shows the attempt.
6. Remove `/etc/source-runner/stay-up`. From then on the instance
   powers off after each check.

The schedule starts the instance at 4:55 p.m. Pacific on weekdays and
stops it at 5:25 p.m. if it is still running. EventBridge Scheduler
follows the Pacific time zone across daylight saving changes.

To update the runner, start the instance, create the `stay-up` file,
run `install.sh` with the new commit, and remove the file again.

None of these files has run on the instance yet. Treat the first
installation as a test.
