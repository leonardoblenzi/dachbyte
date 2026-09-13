import {
  formatBirthday,
  getBirthdayAge,
  getBirthdayTiming,
  isBirthdayToday,
  formatBirthdayInput,
  parseBirthday,
} from './birthdays';

describe('birthday helpers', () => {
  const birthdayDate = new Date(2026, 3, 21);

  it('uses DD-MM-YY and calculates the completed age', () => {
    expect(parseBirthday('21-04-90')).toMatchObject({
      day: 21,
      month: 4,
      year: 90,
      fullYear: 1990,
    });
    expect(formatBirthday('21-04-90')).toBe('21-04-90');
    expect(isBirthdayToday('21-04-90', birthdayDate)).toBe(true);
    expect(getBirthdayAge('21-04-90', birthdayDate)).toBe(36);
    expect(getBirthdayTiming('21-04-90', birthdayDate)).toMatchObject({
      isToday: true,
      age: 36,
      ageAtNextBirthday: 36,
    });
  });


  it('accepts Brazilian separators, full years and digits without separators', () => {
    expect(formatBirthdayInput('24092003')).toBe('24-09-2003');
    expect(formatBirthdayInput('24/09/03')).toBe('24-09-03');
    expect(parseBirthday('24/09/2003')).toMatchObject({
      day: 24,
      month: 9,
      fullYear: 2003,
      hasFourDigitYear: true,
    });
    expect(parseBirthday('24092003')).toMatchObject({ fullYear: 2003 });
    expect(formatBirthday('24/09/2003')).toBe('24-09-2003');
    expect(getBirthdayAge('24092003', new Date(2026, 8, 24))).toBe(23);
  });
  it('keeps legacy MM-DD readable but rejects impossible dates', () => {
    expect(formatBirthday('04-21')).toBe('21-04');
    expect(parseBirthday('31-02-90')).toBeNull();
  });
});
