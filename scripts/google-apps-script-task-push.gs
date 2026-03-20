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
    var payload = {
      title: t.title || 'Untitled task',
      details: t.notes || undefined,
      dueAt: t.due ? new Date(t.due).toISOString() : undefined,
      priority: 'medium',
      tags: ['google-tasks'],
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
}

function trimSlash(value) {
  return value.replace(/\/$/, '');
}
