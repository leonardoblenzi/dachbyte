export const ticketMatchesSearch = (ticket = {}, rawQuery = "") => {
  const term = String(rawQuery || "").trim().toLowerCase();
  if (!term) return true;

  const normalizedTicketNumber = term.replace(/^#\s*/, "");
  if (/^\d+$/.test(normalizedTicketNumber)) {
    return String(ticket.id ?? "") === normalizedTicketNumber;
  }

  return [
    ticket.title,
    ticket.description,
    ticket.channel,
    ticket.department,
    ticket.created_by_name,
    ticket.assigned_to_name,
    ...(ticket.assigned_users || []).map((item) => item.name),
    ticket.attachment_filename,
  ]
    .join(" ")
    .toLowerCase()
    .includes(term);
};
