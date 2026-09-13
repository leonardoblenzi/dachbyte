ALTER TABLE meetings
  ADD COLUMN IF NOT EXISTS link_url TEXT;

ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_meeting_type_check;
ALTER TABLE meetings
  ADD CONSTRAINT meetings_meeting_type_check
  CHECK (meeting_type IN ('reminder', 'task', 'video'));