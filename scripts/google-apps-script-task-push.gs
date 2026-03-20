/**
 * Google Apps Script: push incomplete Google Tasks to reorgable ingest worker.
 *
 * Setup:
 * 1) Set script properties:
 *    - INGEST_URL: https://<your-ingest-worker-domain>
 *    - INGEST_API_TOKEN: <shared bearer token>
 *    - TASKLIST_ID: @default (or a specific task list ID)
 * 2) Add a time-based trigger (for example every 15 minutes) for pushTasksToReorgable.
 */

function pushTasksToReorgable() {
  var props = PropertiesService.getScriptProperties();
  var ingestUrl = props.getProperty('INGEST_URL');
  var apiToken = props.getProperty('INGEST_API_TOKEN');
  var tasklistId = props.getProperty('TASKLIST_ID') || '@default';

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
      externalId: t.id,
      parentTaskId: t.parent || undefined
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
