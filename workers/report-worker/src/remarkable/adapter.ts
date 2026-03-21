export type RemarkableUploadResult = {
  ok: boolean;
  message: string;
  remotePath?: string;
  docId?: string;
};

export type RemarkableDocument = {
  id: string;
  name: string;
  type: "DocumentType" | "CollectionType";
  parentId: string;
  fileType?: string;
  modifiedAt?: string;
};

export type RemarkableListResult = {
  ok: boolean;
  documents: RemarkableDocument[];
  message: string;
};

export type RemarkableDownloadResult = {
  ok: boolean;
  bytes?: Uint8Array;
  message: string;
};

export type MultiUploadItem = {
  fileName: string;
  folder: string;
  bytes: Uint8Array;
};

export type MultiUploadResult = {
  results: RemarkableUploadResult[];
  allOk: boolean;
};

export interface RemarkableAdapter {
  uploadPdf(args: {
    fileName: string;
    folder: string;
    bytes: Uint8Array;
  }): Promise<RemarkableUploadResult>;

  /** Upload multiple PDFs sequentially, returning a result per item. */
  uploadMultiplePdfs(items: MultiUploadItem[]): Promise<MultiUploadResult>;

  /** List documents. If unsupported, returns ok: false. */
  listDocuments(): Promise<RemarkableListResult>;

  /** Download raw document bytes by ID. If unsupported, returns ok: false. */
  downloadDocument(docId: string): Promise<RemarkableDownloadResult>;
}
