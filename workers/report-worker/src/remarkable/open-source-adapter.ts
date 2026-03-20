import type { RemarkableAdapter, RemarkableUploadResult } from "./adapter";

type OpenSourceEnv = {
  REMARKABLE_DEVICE_TOKEN?: string;
  REMARKABLE_SESSION_TOKEN?: string;
  REMARKABLE_WEBAPP_HOST?: string;
  REMARKABLE_INTERNAL_HOST?: string;
};

type UploadResponsePayload = {
  docID: string;
  hash: string;
};

const DEFAULT_WEBAPP_HOST = "https://webapp-prod.cloud.remarkable.engineering";
const DEFAULT_INTERNAL_HOST = "https://internal.cloud.remarkable.com";

const toUploadName = (folder: string, fileName: string): string => {
  const normalizedFolder = folder.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalizedFolder) return fileName;
  return `${normalizedFolder} - ${fileName}`;
};

const encodeRmMeta = (name: string): string => {
  const payload = JSON.stringify({ file_name: name });
  return btoa(payload);
};

export class OpenSourceRemarkableAdapter implements RemarkableAdapter {
  constructor(private readonly env: OpenSourceEnv) {}

  private async getSessionToken(): Promise<string> {
    if (this.env.REMARKABLE_SESSION_TOKEN) {
      return this.env.REMARKABLE_SESSION_TOKEN;
    }
    if (!this.env.REMARKABLE_DEVICE_TOKEN) {
      throw new Error("Missing REMARKABLE_DEVICE_TOKEN or REMARKABLE_SESSION_TOKEN");
    }

    const webappHost = this.env.REMARKABLE_WEBAPP_HOST ?? DEFAULT_WEBAPP_HOST;
    const response = await fetch(`${webappHost}/token/json/2/user/new`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.REMARKABLE_DEVICE_TOKEN}`,
        "content-type": "application/json"
      },
      body: "{}"
    });

    if (!response.ok) {
      throw new Error(`Unable to create reMarkable session token: ${response.status} ${await response.text()}`);
    }

    const token = (await response.text()).trim();
    if (!token) {
      throw new Error("reMarkable session token response was empty");
    }
    return token;
  }

  async uploadPdf(args: {
    fileName: string;
    folder: string;
    bytes: Uint8Array;
  }): Promise<RemarkableUploadResult> {
    try {
      const uploadName = toUploadName(args.folder, args.fileName);
      const token = await this.getSessionToken();
      const internalHost = this.env.REMARKABLE_INTERNAL_HOST ?? DEFAULT_INTERNAL_HOST;

      const bodyBytes = Uint8Array.from(args.bytes);

      const response = await fetch(`${internalHost}/doc/v2/files`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/pdf",
          "rm-meta": encodeRmMeta(uploadName),
          "rm-source": "RoR-Browser"
        },
        body: bodyBytes.buffer
      });

      if (response.status !== 201) {
        return {
          ok: false,
          message: `Open-source API upload failed: ${response.status} ${await response.text()}`
        };
      }

      const payload = (await response.json()) as UploadResponsePayload;

      return {
        ok: true,
        message: `Uploaded via open-source-compatible reMarkable API flow (${payload.docID})`,
        remotePath: `${args.folder}/${args.fileName}`
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Unknown reMarkable upload error"
      };
    }
  }
}
