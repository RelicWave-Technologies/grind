-- m71: what Timo's AI read from a Lark ticket draft (advisory, additive).
ALTER TABLE "TicketDraft" ADD COLUMN "aiSubject" TEXT;
ALTER TABLE "TicketDraft" ADD COLUMN "aiCategory" "TicketCategory";
ALTER TABLE "TicketDraft" ADD COLUMN "aiRelatedTicketId" TEXT;
ALTER TABLE "TicketDraft" ADD COLUMN "aiQuestion" TEXT;
ALTER TABLE "TicketDraft" ADD COLUMN "aiTextHash" TEXT;
