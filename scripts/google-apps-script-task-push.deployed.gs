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
