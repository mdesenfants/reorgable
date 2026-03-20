/**
 * Google Apps Script: push incomplete Google Tasks to reorgable ingest worker.
 *
 * Deployment-ready defaults for your current Cloudflare deployment.
 *
 * Setup:
 * 1) In Apps Script, open Project Settings -> Script properties.
 * 2) Set INGEST_API_TOKEN to your ingest worker bearer token.
 * 3) Optional: set TASKLIST_ID (defaults to @default).
 *
 * Notes:
 * - INGEST_URL is pre-populated for your deployed ingest worker.
 * - Script property values override defaults below.
 */

var DEFAULT_INGEST_URL = 'https://reorgable-ingest.<your-subdomain>.workers.dev';
var DEFAULT_TASKLIST_ID = '@default';

function pushTasksToReorgable() {
  var props = PropertiesService.getScriptProperties();
  var ingestUrl = props.getProperty('INGEST_URL') || DEFAULT_INGEST_URL;
  var apiToken = props.getProperty('INGEST_API_TOKEN');
  var tasklistId = props.getProperty('TASKLIST_ID') || DEFAULT_TASKLIST_ID;

  if (!ingestUrl || !apiToken) {
    throw new Error('Missing INGEST_URL or INGEST_API_TOKEN in script properties');
  }

  var tasks = Tasks.Tasks.list(tasklistId, {
    showCompleted: false,
    showHidden: false,
    maxResults: 100
  });

  var items = tasks.items || [];
  for (var i = 0; i < items.length; i++) {
    var t = items[i];
    var emailContext = extractEmailContext(t.notes || '');
    var payload = {
      title: t.title || 'Untitled task',
      details: t.notes || undefined,
      dueAt: t.due ? new Date(t.due).toISOString() : undefined,
      priority: 'medium',
      tags: ['google-tasks'],
      relatedEmailSubject: emailContext.subject,
      relatedEmailFrom: emailContext.from,
      relatedEmailMessageId: emailContext.messageId,
      externalId: t.id
    };

    var response = UrlFetchApp.fetch(trimSlash(ingestUrl) + '/ingest/task', {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      headers: {
        Authorization: 'Bearer ' + apiToken
      },
      payload: JSON.stringify(payload)
    });

    var code = response.getResponseCode();
    if (code < 200 || code > 299) {
      Logger.log('Failed task push for id=%s code=%s body=%s', t.id, code, response.getContentText());
    }
  }

  pushTodayCalendarEventsToReorgable(ingestUrl, apiToken);
}

function trimSlash(value) {
  return value.replace(/\/$/, '');
}

function extractEmailContext(notes) {
  var messageIdMatch = notes.match(/message-id\s*[:=]\s*<?([^>\s]+)>?/i);
  var fromMatch = notes.match(/from\s*[:=]\s*([^\n\r]+)/i);
  var subjectMatch = notes.match(/subject\s*[:=]\s*([^\n\r]+)/i);

  return {
    messageId: messageIdMatch ? String(messageIdMatch[1]).trim() : undefined,
    from: fromMatch ? extractEmailAddress(String(fromMatch[1])) : undefined,
    subject: subjectMatch ? String(subjectMatch[1]).trim() : undefined
  };
}

function extractEmailAddress(value) {
  var emailMatch = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return emailMatch ? String(emailMatch[0]).toLowerCase() : undefined;
}

function pushTodayCalendarEventsToReorgable(ingestUrl, apiToken) {
  var calendars = CalendarApp.getAllCalendars();
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  var end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  for (var c = 0; c < calendars.length; c++) {
    var cal = calendars[c];
    var events = cal.getEvents(start, end);

    for (var e = 0; e < events.length; e++) {
      var event = events[e];
      var calendarPayload = {
        title: event.getTitle() || 'Untitled event',
        startAt: event.getStartTime().toISOString(),
        endAt: event.getEndTime().toISOString(),
        calendarName: cal.getName() || 'Calendar',
        isAllDay: event.isAllDayEvent(),
        externalId: cal.getId() + ':' + event.getId() + ':' + event.getStartTime().getTime()
      };

      var response = UrlFetchApp.fetch(trimSlash(ingestUrl) + '/ingest/calendar', {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        headers: {
          Authorization: 'Bearer ' + apiToken
        },
        payload: JSON.stringify(calendarPayload)
      });

      var code = response.getResponseCode();
      if (code < 200 || code > 299) {
        Logger.log('Failed calendar push for calendar=%s event=%s code=%s body=%s', cal.getName(), event.getTitle(), code, response.getContentText());
      }
    }
  }
}
