UPDATE messages
SET content = REPLACE(
  REPLACE(
    REPLACE(
      content,
      'Resumo di' || CHR(195) || CHR(161) || 'rio do Bolt',
      'Resumo diário do Bolt'
    ),
    'voc' || CHR(195) || CHR(170), 'você'
  ),
  'n' || CHR(195) || CHR(163) || 'o', 'não'
)
WHERE message_type = 'ticket_daily_summary'
  AND POSITION(CHR(195) IN content) > 0;
