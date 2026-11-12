import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type StateEventType =
  | 'startup'
  | 'version-adopted'
  | 'version-rejected'
  | 'shutdown'
  | 'probe'
  | 'restart';

export interface StateRecord {
  readonly ts: string;
  readonly event: StateEventType;
  readonly pid: number;
  readonly activeVersion: string | null;
  readonly revision: number | null;
  readonly detail: string;
  readonly issues?: readonly { readonly code: string; readonly message: string }[];
}

/**
 * append-only 状态记录。每次写入单独成行、各自 fs 追加，
 * 进程被停止后重启仍能读到完整历史，并能看出最终采用了哪个版本。
 */
export class StateJournal {
  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<StateJournal> {
    await mkdir(dirname(file), { recursive: true });
    return new StateJournal(file);
  }

  async append(event: StateEventType, fields: Omit<StateRecord, 'ts' | 'event' | 'pid'>): Promise<void> {
    const record: StateRecord = {
      ts: new Date().toISOString(),
      event,
      pid: process.pid,
      activeVersion: fields.activeVersion,
      revision: fields.revision,
      detail: fields.detail,
      ...(fields.issues ? { issues: fields.issues } : {}),
    };
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  async readAll(): Promise<StateRecord[]> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const records: StateRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as StateRecord);
      } catch {
        // 跳过被截断的末行，保证历史可读。
      }
    }
    return records;
  }

  /** 最后一条采用成功的版本记录，用于回答「现在用的是哪个版本」。 */
  async latestAdopted(): Promise<StateRecord | null> {
    const records = await this.readAll();
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i]!;
      if (record.event === 'version-adopted' || record.event === 'startup') return record;
    }
    return null;
  }
}
