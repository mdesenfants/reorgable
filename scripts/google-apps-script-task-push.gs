/**
 * Google Apps Script: push Google Tasks state to reorgable ingest worker.
 *
 * Setup:
 * 1) Set script properties:
 *    - INGEST_URL: https://<your-ingest-worker-domain>
 *    - INGEST_API_TOKEN: <shared bearer token>
 *    - TASKLIST_ID: @default (or a specific task list ID)
 * 2) Add a time-based trigger (for example every 15 minutes) for pushTasksToReorgable.
 * 3) Optional: TASKS_UPDATED_CURSOR is maintained automatically for completed/deleted sync.
 */

function pushTasksToReorgable() {
  var props = PropertiesService.getScriptProperties();
  var ingestUrl = props.getProperty('INGEST_URL');
  var apiToken = props.getProperty('INGEST_API_TOKEN');
  var tasklistId = props.getProperty('TASKLIST_ID') || '@default';
  var updatedCursor = props.getProperty('TASKS_UPDATED_CURSOR');
  var runStartedAt = new Date().toISOString();

  if (!ingestUrl || !apiToken) {
    throw new Error('Missing INGEST_URL or INGEST_API_TOKEN in script properties');
  }

  pushOpenTasksToReorgable(ingestUrl, apiToken, tasklistId);
  pushRecentlyClosedTasksToReorgable(ingestUrl, apiToken, tasklistId, updatedCursor);
  props.setProperty('TASKS_UPDATED_CURSOR', runStartedAt);

  pushTodayCalendarEventsToReorgable(ingestUrl, apiToken);
}

function listAllTasks(tasklistId, options) {
  var collected = [];
  var pageToken;

  do {
    var requestOptions = {};
    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        requestOptions[key] = options[key];
      }
    }
    if (pageToken) {
      requestOptions.pageToken = pageToken;
    }

    var response = Tasks.Tasks.list(tasklistId, requestOptions);
    var items = response.items || [];
    for (var i = 0; i < items.length; i++) {
      collected.push(items[i]);
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  return collected;
}

function pushTaskPayload(ingestUrl, apiToken, task, isDone) {
  var emailContext = extractEmailContext(task.notes || '');
  var payload = {
    title: task.title || 'Untitled task',
    details: task.notes || undefined,
    dueAt: task.due ? new Date(task.due).toISOString() : undefined,
    priority: 'medium',
    tags: ['google-tasks'],
    isDone: isDone,
    relatedEmailSubject: emailContext.subject,
    relatedEmailFrom: emailContext.from,
    relatedEmailMessageId: emailContext.messageId,
    externalId: task.id,
    parentTaskId: task.parent || undefined
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
    Logger.log('Failed task push for id=%s done=%s code=%s body=%s', task.id, isDone, code, response.getContentText());
  }
}

function pushOpenTasksToReorgable(ingestUrl, apiToken, tasklistId) {
  var items = listAllTasks(tasklistId, {
    showCompleted: false,
    showHidden: false,
    maxResults: 100
  });

  for (var i = 0; i < items.length; i++) {
    pushTaskPayload(ingestUrl, apiToken, items[i], false);
  }
}

function pushRecentlyClosedTasksToReorgable(ingestUrl, apiToken, tasklistId, updatedCursor) {
  var options = {
    showCompleted: true,
    showDeleted: true,
    showHidden: true,
    maxResults: 100
  };

  if (updatedCursor) {
    options.updatedMin = updatedCursor;
  }

  var items = listAllTasks(tasklistId, options);
  for (var i = 0; i < items.length; i++) {
    var task = items[i];
    var isDone = task.status === 'completed' || task.deleted === true;
    if (!isDone) continue;
    pushTaskPayload(ingestUrl, apiToken, task, true);
  }
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
