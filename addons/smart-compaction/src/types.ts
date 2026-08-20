import type { Usage } from "@earendil-works/pi-ai";

export interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface CompactionResult<T = Usage> {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: T;
}
