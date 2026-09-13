import React, { useEffect, useMemo, useState } from 'react';
import { Cake, CalendarDays, Gift, PartyPopper, RefreshCw, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_BASE_URL } from '../config';
import { formatBirthday, sortBirthdays } from '../utils/birthdays';

const BirthdayAvatar = ({ user, festive = false }) => (
  <div className={`birthday-list-avatar ${festive ? 'birthday-list-avatar--festive' : ''}`}>
    {(user.full_name || user.username || 'U').charAt(0).toUpperCase()}
    {festive && (
      <>
        <span className="party-hat" />
        <span className="avatar-confetti avatar-confetti--one" />
        <span className="avatar-confetti avatar-confetti--two" />
        <span className="avatar-confetti avatar-confetti--three" />
      </>
    )}
  </div>
);

const BirthdayCard = ({ user, tone = 'upcoming' }) => {
  const timing = user.birthdayTiming;
  const isToday = timing?.isToday;
  const label = isToday
    ? 'Hoje'
    : tone === 'recent'
      ? `${timing?.daysSince || 0} dia(s) atras`
      : `${timing?.daysUntil || 0} dia(s)`;

  const age = isToday
    ? timing?.age
    : tone === 'recent' ? timing?.ageAtLastBirthday : timing?.ageAtNextBirthday;
  const ageLabel = age === null || age === undefined ? null
    : isToday ? `${age} anos hoje` : tone === 'recent' ? `Completou ${age} anos` : `Fara ${age} anos`;
  return (
    <article className={`birthday-card ${isToday ? 'birthday-card--today' : ''}`}>
      <BirthdayAvatar user={user} festive={isToday} />
      <div className="min-w-0">
        <h3>{user.full_name || user.username}</h3>
        <p>@{user.username} {user.department ? `- ${user.department}` : ''}</p>
        <div className="birthday-card__meta">
          <span>
            <Cake size={13} />
            {formatBirthday(user.birthday)}
          </span>
          <span>
            <CalendarDays size={13} />
            {label}
          </span>
          {ageLabel && (
            <span>
              <Gift size={13} />
              {ageLabel}
            </span>
          )}
        </div>
      </div>
    </article>
  );
};

const Birthdays = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadBirthdays = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/birthdays/`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (!response.ok) {
        throw new Error('Nao foi possivel carregar aniversariantes.');
      }
      setUsers(await response.json());
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBirthdays();
  }, []);

  const birthdayGroups = useMemo(() => sortBirthdays(users), [users]);
  const nextBirthday = birthdayGroups.upcoming[0];

  return (
    <div className="work-page birthdays-page">
      <section className="birthday-hero panel">
        <div>
          <span className="badge badge--success">
            <Sparkles size={13} />
            Celebracoes
          </span>
          <h2>Aniversariantes do Volt Corp</h2>
          <p>Veja quem esta comemorando hoje, quem vem nos proximos dias e quem comemorou recentemente.</p>
        </div>

        <button className="button-secondary" type="button" onClick={loadBirthdays} disabled={loading}>
          <RefreshCw size={17} />
          Atualizar
        </button>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <article className="metric-card birthday-metric">
          <PartyPopper size={22} />
          <p>Hoje</p>
          <strong>{birthdayGroups.today.length}</strong>
        </article>
        <article className="metric-card birthday-metric">
          <Gift size={22} />
          <p>Proximo</p>
          <strong>{nextBirthday ? `${nextBirthday.birthdayTiming.daysUntil} dia(s)` : '-'}</strong>
        </article>
        <article className="metric-card birthday-metric">
          <Cake size={22} />
          <p>Cadastrados</p>
          <strong>{users.length}</strong>
        </article>
      </section>

      {loading ? (
        <section className="empty-state">
          <div className="spinner h-6 w-6" />
          <h2>Carregando aniversariantes</h2>
        </section>
      ) : (
        <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
          <div className="panel p-5 xl:col-span-2">
            <div className="birthday-section-title">
              <PartyPopper size={19} />
              <div>
                <h3>Hoje e dia de festa</h3>
                <p>{birthdayGroups.today.length ? 'Capriche nos parabens.' : 'Nenhum aniversario hoje.'}</p>
              </div>
            </div>
            <div className="birthday-grid">
              {birthdayGroups.today.length ? (
                birthdayGroups.today.map((item) => <BirthdayCard key={item.id} user={item} />)
              ) : (
                <div className="birthday-empty">Sem aniversariantes hoje.</div>
              )}
            </div>
          </div>

          <div className="panel p-5">
            <div className="birthday-section-title">
              <Gift size={19} />
              <div>
                <h3>Proximos aniversariantes</h3>
                <p>Ordenado por quem comemora primeiro.</p>
              </div>
            </div>
            <div className="birthday-stack">
              {birthdayGroups.upcoming.map((item) => (
                <BirthdayCard key={item.id} user={item} />
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <div className="birthday-section-title">
              <CalendarDays size={19} />
              <div>
                <h3>Ultimos aniversarios</h3>
                <p>Quem comemorou recentemente.</p>
              </div>
            </div>
            <div className="birthday-stack">
              {birthdayGroups.recent.map((item) => (
                <BirthdayCard key={item.id} user={item} tone="recent" />
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export default Birthdays;
