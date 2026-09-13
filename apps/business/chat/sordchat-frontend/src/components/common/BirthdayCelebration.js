import React, { useEffect, useMemo, useState } from 'react';
import { Cake, PartyPopper, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { formatBirthday, getBirthdayAge, isBirthdayToday } from '../../utils/birthdays';

const confettiPieces = Array.from({ length: 34 }, (_, index) => index);

const getTodayKey = () => {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
};

const BirthdayCelebration = () => {
  const { user } = useAuth();
  const [visible, setVisible] = useState(false);

  const storageKey = useMemo(() => {
    if (!user?.id) {
      return null;
    }
    return `voltcorp:birthday-celebration:${user.id}:${getTodayKey()}`;
  }, [user?.id]);

  useEffect(() => {
    if (!user || !storageKey || !isBirthdayToday(user.birthday)) {
      setVisible(false);
      return;
    }

    if (localStorage.getItem(storageKey)) {
      setVisible(false);
      return;
    }

    localStorage.setItem(storageKey, 'shown');
    setVisible(true);
  }, [storageKey, user]);

  if (!visible || !user) {
    return null;
  }

  const age = getBirthdayAge(user.birthday);
  return (
    <div className="birthday-celebration" role="dialog" aria-live="polite" aria-label="Mensagem de aniversario">
      <div className="birthday-confetti-layer" aria-hidden="true">
        {confettiPieces.map((piece) => (
          <span key={piece} style={{ '--i': piece }} />
        ))}
      </div>

      <section className="birthday-toast panel">
        <button className="birthday-toast__close" type="button" onClick={() => setVisible(false)} aria-label="Fechar">
          <X size={17} />
        </button>
        <div className="birthday-toast__icon">
          <PartyPopper size={24} />
        </div>
        <h2>Feliz aniversario, {user.full_name || user.username}!</h2>
        <p>
          {age !== null
            ? `Hoje voce completa ${age} anos! Que venha um ciclo leve, produtivo e cheio de boas conversas.`
            : 'Hoje e seu dia no Volt Corp. Que venha um ciclo leve, produtivo e cheio de boas conversas.'}
        </p>
        <span className="badge badge--success">
          <Cake size={13} />
          {formatBirthday(user.birthday)}{age !== null ? ` - ${age} anos` : ''}
        </span>
      </section>
    </div>
  );
};

export default BirthdayCelebration;
