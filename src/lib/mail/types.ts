export type GmailProfile = {
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
};

export type GmailHeader = { name: string; value: string };

export type GmailPayload = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPayload[];
};

export type GmailFetchedMessage = {
  id: string;
  threadId: string;
  historyId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayload;
};

export type GmailListPage = {
  messages: { id: string; threadId: string }[];
  nextPageToken?: string;
};

export type GmailHistoryRecord = {
  id: string;
  messagesAdded?: { id: string; threadId: string }[];
  messagesDeleted?: { id: string; threadId: string }[];
  labelsAdded?: { id: string; threadId: string }[];
  labelsRemoved?: { id: string; threadId: string }[];
};

export type GmailHistoryPage =
  | { expired: true }
  | {
      expired: false;
      history: GmailHistoryRecord[];
      historyId: string;
      nextPageToken?: string;
    };

export type GmailGetFormat = "full" | "minimal";

/** Read methods only. There is no send, modify, or delete on this interface. */
export interface GmailReadClient {
  getProfile(): Promise<GmailProfile>;
  listMessages(args: { pageToken?: string; maxResults: number }): Promise<GmailListPage>;
  getMessage(id: string, format: GmailGetFormat): Promise<GmailFetchedMessage | null>;
  listHistory(args: { startHistoryId: string; pageToken?: string; maxResults: number }): Promise<GmailHistoryPage>;
}
