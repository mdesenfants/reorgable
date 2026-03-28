/**
 * Google Apps Script: push Google Tasks state to reorgable ingest worker.
 *
 * Deployment-ready defaults for your current Cloudflare deployment.
 *
 * Setup:
 * 1) In Apps Script, open Project Settings -> Script properties.
 * 2) Set INGEST_API_TOKEN to your ingest worker bearer token.
 * 3) Optional: set TASKLIST_ID (defaults to @default).
 * 4) Optional: TASKS_UPDATED_CURSOR is maintained automatically for completed/deleted sync.
 *
 * Notes:
 * - INGEST_URL is pre-populated for your deployed ingest worker.
 * - Script property values override defaults below.
 */

var DEFAULT_INGEST_URL = 'https://reorgable-ingest.matt-desenfants.workers.dev';
var DEFAULT_TASKLIST_ID = '@default';

function pushTasksToReorgable() {
  var props = PropertiesService.getScriptProperties();
  var ingestUrl = props.getProperty('INGEST_URL') || DEFAULT_INGEST_URL;
  var apiToken = props.getProperty('INGEST_API_TOKEN');
  var tasklistId = props.getProperty('TASKLIST_ID') || DEFAULT_TASKLIST_ID;
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
  var CHUNK = 50;
  for (var start = 0; start < requests.length; start += CHUNK) {
    var chunk = requests.slice(start, start + CHUNK);
    var responses = UrlFetchApp.fetchAll(chunk);
    for (var i = 0; i < responses.length; i++) {
      var code = responses[i].getResponseCode();
      if (code < 200 || code > 299) {
        Logger.log('Batch item %s failed: %s %s', start + i, code, responses[i].getContentText());
      }
    }
    if (start + CHUNK < requests.length) {
      Utilities.sleep(500);
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
