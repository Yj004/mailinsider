-- RFC Message-ID fields so follow-ups stay in the same Gmail thread.
alter table public.messages add column if not exists rfc_message_id varchar(320);
alter table public.message_replies add column if not exists rfc_message_id varchar(320);
