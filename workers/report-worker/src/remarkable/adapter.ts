export type RemarkableUploadResult = {
  ok: boolean;
  message: string;
  remotePath?: string;
};

export interface RemarkableAdapter {
  uploadPdf(args: {
    fileName: string;
    folder: string;
    bytes: Uint8Array;
  }): Promise<RemarkableUploadResult>;
}
