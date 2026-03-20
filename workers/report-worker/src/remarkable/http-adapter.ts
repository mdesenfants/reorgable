import type { RemarkableAdapter, RemarkableUploadResult } from "./adapter";

type RemarkableEnv = {
  REMARKABLE_IMPORT_URL?: string;
  REMARKABLE_DEVICE_TOKEN?: string;
};

export class HttpRemarkableAdapter implements RemarkableAdapter {
  constructor(private readonly env: RemarkableEnv) {}

  async uploadPdf(args: {
    fileName: string;
    folder: string;
    bytes: Uint8Array;
  }): Promise<RemarkableUploadResult> {
    if (!this.env.REMARKABLE_IMPORT_URL || !this.env.REMARKABLE_DEVICE_TOKEN) {
      return {
        ok: false,
        message: "Missing REMARKABLE_IMPORT_URL or REMARKABLE_DEVICE_TOKEN"
      };
    }

    const bodyBytes = Uint8Array.from(args.bytes);

    const response = await fetch(this.env.REMARKABLE_IMPORT_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.REMARKABLE_DEVICE_TOKEN}`,
        "content-type": "application/pdf",
        "x-file-name": args.fileName,
        "x-folder": args.folder
      },
      body: bodyBytes.buffer
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        message: `Upload failed with status ${response.status}: ${body.slice(0, 300)}`
      };
    }

    return {
      ok: true,
      message: "Uploaded PDF to reMarkable import endpoint",
      remotePath: `${args.folder}/${args.fileName}`
    };
  }
}
