const birthdaySeparators = /[-/.]/;

export const formatBirthdayInput = (value) => {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
};

export const parseBirthday = (value) => {
  if (!value) {
    return null;
  }

  const rawValue = String(value).trim();
  const digits = rawValue.replace(/\D/g, '');
  const normalizedValue = /^\d{6}$|^\d{8}$/.test(digits)
    ? formatBirthdayInput(digits)
    : rawValue;
  const partTexts = normalizedValue.split(birthdaySeparators);
  const parts = partTexts.map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) {
    return null;
  }

  let month;
  let day;
  let year = null;
  let fullYear = null;
  let hasFourDigitYear = false;

  if (parts.length >= 3) {
    if (parts[0] > 999) {
      [fullYear, month, day] = parts;
      year = fullYear % 100;
    } else {
      [day, month, fullYear] = parts;
      year = fullYear % 100;
      hasFourDigitYear = partTexts[2].length === 4;
      if (!hasFourDigitYear) {
        const currentShortYear = new Date().getFullYear() % 100;
        fullYear = (year <= currentShortYear ? 2000 : 1900) + year;
      }
    }
  } else if (parts.length === 2) {
    const [first, second] = parts;
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
  }

  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const validationYear = fullYear || 2000;
  const validationDate = new Date(validationYear, month - 1, day);
  if (validationDate.getMonth() !== month - 1 || validationDate.getDate() !== day) {
    return null;
  }

  return { month, day, year, fullYear, hasFourDigitYear };
};
export const formatBirthday = (value) => {
  const birthday = parseBirthday(value);
  if (!birthday) {
    return value || '';
  }

  const displayedYear = birthday.hasFourDigitYear ? birthday.fullYear : birthday.year;
  return [birthday.day, birthday.month, displayedYear].filter((part) => part !== null).map((part) => String(part).padStart(2, '0')).join('-');
};

const buildDateForYear = (birthday, year) => new Date(year, birthday.month - 1, birthday.day);

export const getBirthdayAge = (value, baseDate = new Date()) => {
  const birthday = parseBirthday(value);
  if (!birthday?.fullYear) return null;
  let age = baseDate.getFullYear() - birthday.fullYear;
  const beforeBirthday = baseDate.getMonth() + 1 < birthday.month
    || (baseDate.getMonth() + 1 === birthday.month && baseDate.getDate() < birthday.day);
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
};


export const isBirthdayToday = (value, baseDate = new Date()) => {
  const birthday = parseBirthday(value);
  if (!birthday) {
    return false;
  }

  return birthday.month === baseDate.getMonth() + 1 && birthday.day === baseDate.getDate();
};

export const getBirthdayTiming = (value, baseDate = new Date()) => {
  const birthday = parseBirthday(value);
  if (!birthday) {
    return null;
  }

  const today = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  let nextDate = buildDateForYear(birthday, today.getFullYear());
  if (nextDate < today) {
    nextDate = buildDateForYear(birthday, today.getFullYear() + 1);
  }

  let lastDate = buildDateForYear(birthday, today.getFullYear());
  if (lastDate > today) {
    lastDate = buildDateForYear(birthday, today.getFullYear() - 1);
  }

  const dayMs = 24 * 60 * 60 * 1000;
  return {
    nextDate,
    lastDate,
    daysUntil: Math.round((nextDate - today) / dayMs),
    daysSince: Math.round((today - lastDate) / dayMs),
    isToday: nextDate.getTime() === today.getTime(),
    age: getBirthdayAge(value, today),
    ageAtNextBirthday: birthday.fullYear ? nextDate.getFullYear() - birthday.fullYear : null,
    ageAtLastBirthday: birthday.fullYear ? lastDate.getFullYear() - birthday.fullYear : null,
  };
};

export const sortBirthdays = (users, baseDate = new Date()) => {
  const withTiming = users
    .map((user) => ({ ...user, birthdayTiming: getBirthdayTiming(user.birthday, baseDate) }))
    .filter((user) => user.birthdayTiming);

  return {
    today: withTiming
      .filter((user) => user.birthdayTiming.isToday)
      .sort((a, b) => (a.full_name || a.username || '').localeCompare(b.full_name || b.username || '')),
    upcoming: [...withTiming]
      .sort((a, b) => a.birthdayTiming.daysUntil - b.birthdayTiming.daysUntil)
      .slice(0, 8),
    recent: [...withTiming]
      .filter((user) => !user.birthdayTiming.isToday)
      .sort((a, b) => a.birthdayTiming.daysSince - b.birthdayTiming.daysSince)
      .slice(0, 8),
  };
};
