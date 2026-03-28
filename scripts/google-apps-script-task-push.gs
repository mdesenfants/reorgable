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

function buildTaskRequest(ingestUrl, apiToken, task, isDone) {
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

  return {
    url: trimSlash(ingestUrl) + '/ingest/task',
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + apiToken },
    payload: JSON.stringify(payload)
  };
}

function sendBatch(requests) {
  if (requests.length === 0) return;
  var responses = UrlFetchApp.fetchAll(requests);
  for (var i = 0; i < responses.length; i++) {
    var code = responses[i].getResponseCode();
    if (code < 200 || code > 299) {
      Logger.log('Batch item %s failed: %s %s', i, code, responses[i].getContentText());
    }
  }
}

function pushOpenTasksToReorgable(ingestUrl, apiToken, tasklistId) {
  var items = listAllTasks(tasklistId, {
    showCompleted: false,
    showHidden: false,
    maxResults: 100
  });

  var requests = [];
  for (var i = 0; i < items.length; i++) {
    requests.push(buildTaskRequest(ingestUrl, apiToken, items[i], false));
  }
  Logger.log('Sending %s open task requests', requests.length);
  sendBatch(requests);
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
  var requests = [];
  for (var i = 0; i < items.length; i++) {
    var task = items[i];
    var isDone = task.status === 'completed' || task.deleted === true;
    if (!isDone) continue;
    requests.push(buildTaskRequest(ingestUrl, apiToken, task, true));
  }
  Logger.log('Sending %s closed task requests', requests.length);
  sendBatch(requests);
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

function truncate(value, maxLen) {
  if (!value) return '';
  return value.length > maxLen ? value.substring(0, maxLen) : value;
}

function isSkippableCalendar(calId) {
  // Skip holiday, birthday, and other Google-generated calendars
  return /^(en\.|#contacts@|addressbook#)/.test(calId) ||
    calId.indexOf('#holiday@') !== -1 ||
    calId.indexOf('group.v.calendar.google.com') !== -1;
}

function buildOrganizer(event) {
  try {
    var creators = event.getCreators();
    if (!creators || creators.length === 0) return undefined;
    return { name: '', email: creators[0] };
  } catch (err) {
    return undefined;
  }
}

function pushTodayCalendarEventsToReorgable(ingestUrl, apiToken) {
  var calendars = CalendarApp.getAllCalendars();
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  var end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  var requests = [];
  for (var c = 0; c < calendars.length; c++) {
    var cal = calendars[c];
    if (isSkippableCalendar(cal.getId())) continue;

    var events = cal.getEvents(start, end);
    for (var e = 0; e < events.length; e++) {
      var event = events[e];
      var calendarPayload = {
        title: event.getTitle() || 'Untitled event',
        startAt: event.getStartTime().toISOString(),
        endAt: event.getEndTime().toISOString(),
        calendarName: cal.getName() || 'Calendar',
        isAllDay: event.isAllDayEvent(),
        externalId: cal.getId() + ':' + event.getId() + ':' + event.getStartTime().getTime(),
        location: event.getLocation() || undefined,
        bodyPreview: truncate(event.getDescription(), 500) || undefined,
        organizer: buildOrganizer(event)
      };

      requests.push({
        url: trimSlash(ingestUrl) + '/ingest/calendar',
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + apiToken },
        payload: JSON.stringify(calendarPayload)
      });
    }
  }

  Logger.log('Sending %s calendar requests across %s calendars', requests.length, calendars.length);
  sendBatch(requests);
}
