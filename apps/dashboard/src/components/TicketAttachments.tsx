import { useState } from 'react';
import { Paperclip } from 'lucide-react';
import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENTS_PER_POST,
  type TicketAttachmentDto,
} from '@grind/types';
import { API_BASE, ApiError } from '../lib/api';

/** Upload one file for a ticket; the server checks what the bytes really are. */
async function uploadTicketFile(file: File): Promise<TicketAttachmentDto> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(`${API_BASE}/v1/tickets/attachments`, { method: 'POST', body: form, credentials: 'include' });
  const body = (await res.json().catch(() => ({}))) as TicketAttachmentDto & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body, body.error ?? `upload failed (${res.status})`);
  return body;
}

const UPLOAD_ERRORS: Record<string, string> = {
  attachment_too_large: 'is over 5 MB',
  attachment_type_not_allowed: 'is not an image, PDF or text file',
  rate_limited: 'could not be added: too many uploads this hour',
};

export function attachmentUrl(a: TicketAttachmentDto): string {
  return `${API_BASE}${a.url}`;
}

/**
 * Pick, drop or paste files for a ticket or reply. Uploads start at once, so
 * the parent only ever holds ids of files the server already accepted.
 */
export function useTicketUploads() {
  const [files, setFiles] = useState<TicketAttachmentDto[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function add(list: FileList | File[]) {
    setError(null);
    const incoming = Array.from(list);
    const room = TICKET_ATTACHMENTS_PER_POST - files.length - busy;
    if (incoming.length > room) setError(`Up to ${TICKET_ATTACHMENTS_PER_POST} files at a time.`);
    for (const file of incoming.slice(0, Math.max(0, room))) {
      if (file.size > TICKET_ATTACHMENT_MAX_BYTES) {
        setError(`${file.name} is over 5 MB.`);
        continue;
      }
      setBusy((n) => n + 1);
      try {
        const uploaded = await uploadTicketFile(file);
        setFiles((cur) => [...cur, uploaded]);
      } catch (err) {
        const code = err instanceof ApiError ? (err.body as { error?: string })?.error : undefined;
        setError(`${file.name} ${code && UPLOAD_ERRORS[code] ? UPLOAD_ERRORS[code] : 'could not be uploaded'}.`);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  }

  return {
    files,
    ids: files.map((f) => f.id),
    busy: busy > 0,
    error,
    add,
    remove: (id: string) => setFiles((cur) => cur.filter((f) => f.id !== id)),
    clear: () => {
      setFiles([]);
      setError(null);
    },
    /** onPaste handler for a textarea: screenshots pasted from the clipboard become uploads. */
    onPaste: (e: React.ClipboardEvent) => {
      const pasted = Array.from(e.clipboardData.files);
      if (pasted.length > 0) {
        e.preventDefault();
        void add(pasted);
      }
    },
  };
}

export type TicketUploads = ReturnType<typeof useTicketUploads>;

/** Attachments already on a ticket: images as thumbnails, files as links. */
export function TicketAttachmentList({ items }: { items: TicketAttachmentDto[] }) {
  if (items.length === 0) return null;
  return (
    <div className="tk-files">
      {items.map((a) =>
        a.mimeType.startsWith('image/') ? (
          <a key={a.id} href={attachmentUrl(a)} target="_blank" rel="noreferrer" className="tk-files__thumb" title={a.fileName}>
            <img src={attachmentUrl(a)} alt={a.fileName} loading="lazy" />
          </a>
        ) : (
          <a key={a.id} href={attachmentUrl(a)} target="_blank" rel="noreferrer" className="tk-files__file ui-t-small">
            <Paperclip size={13} strokeWidth={1.8} /> {a.fileName}
          </a>
        ),
      )}
    </div>
  );
}
