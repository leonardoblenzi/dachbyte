import { ticketMatchesSearch } from "./ticketSearch";

describe("ticketMatchesSearch", () => {
  const ticket = {
    id: 12,
    title: "Revisar estoque",
    description: "Conferir saldo da loja",
  };

  it("finds a ticket by its exact number with or without #", () => {
    expect(ticketMatchesSearch(ticket, "12")).toBe(true);
    expect(ticketMatchesSearch(ticket, "#12")).toBe(true);
  });

  it("does not match a different ticket number by partial text", () => {
    expect(ticketMatchesSearch(ticket, "120")).toBe(false);
  });
});
