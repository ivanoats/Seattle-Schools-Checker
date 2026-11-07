import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {summaryRows,selectSample} from '../src/schoology.js';
import {isSignedIn} from '../src/auth.js';

test('Schoology reads rendered work without counting hidden overdue rows or external links',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.setContent(`<main><div class="upcoming-event" data-start="1794038340">
      <span aria-label="Literature"><span class="event-title"><a href="https://app.schoology.com/assignment/123">Video essay</a></span></span>
      <img alt="Due Friday at 11:59 pm"></div>
      <div class="upcoming-event" style="display:none"><span class="event-title"><a href="https://app.schoology.com/assignment/999">Hidden future overdue</a></span></div>
      <div class="upcoming-event"><span class="event-title"><a href="https://outside.invalid/">External</a></span></div>
      <div class="recently-completed-event"><span class="recently-completed-title"><a href="https://app.schoology.com/assignment/321">Outline</a></span><span class="recently-completed-grade" aria-label="This material has been submitted but not yet graded">-</span></div></main>`);
    const rows=await page.locator('main').evaluate(summaryRows);
    assert.equal(rows.length,2);assert.equal(rows[0].assignment,'Video essay');
    assert.equal(rows[0].course,'Literature');assert.equal(rows[0].scheduledAt,'2026-11-07T07:59:00.000Z');
    assert.equal(rows[1].submissionStatus,'This material has been submitted but not yet graded');
  } finally {await browser.close();}
});
test('Schoology login is separate from verified Sample identity',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    let name='Another Student';
    await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:`<a aria-label="Calendar" href="/parent/calendar">Calendar</a><button>Courses</button><div id="child-session-banner">You are viewing as ${name}</div>`}));
    await page.goto('https://app.schoology.com/parent/home');
    assert.equal(await isSignedIn(page,'schoology'),true);
    await assert.rejects(selectSample(page),e=>e.status==='schoology_select_sample_required');
    name='Sample Student';await selectSample(page);
  } finally {await browser.close();}
});
