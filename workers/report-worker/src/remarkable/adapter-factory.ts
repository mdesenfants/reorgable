import type { RemarkableAdapter } from "./adapter";
import { HttpRemarkableAdapter } from "./http-adapter";
import { OpenSourceRemarkableAdapter } from "./open-source-adapter";

type RemarkableEnv = {
  REMARKABLE_IMPORT_URL?: string;
  REMARKABLE_DEVICE_TOKEN?: string;
  REMARKABLE_SESSION_TOKEN?: string;
  REMARKABLE_WEBAPP_HOST?: string;
  REMARKABLE_INTERNAL_HOST?: string;
};

export function makeRemarkableAdapter(env: RemarkableEnv): RemarkableAdapter {
  if (env.REMARKABLE_SESSION_TOKEN || env.REMARKABLE_DEVICE_TOKEN) {
    return new OpenSourceRemarkableAdapter(env);
  }
  return new HttpRemarkableAdapter(env);
}
