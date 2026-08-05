import React, { useState } from 'react';
import './PlayerLoyaltyCard.css';

// Card de fidelidade no perfil do jogador (Fase 1): pontos, nível VIP,
// progresso para o próximo nível e extrato recente de pontos.

const fmtPts = (n) => Math.round(Number(n) || 0).toLocaleString();

const fmtDate = (iso, locale) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short' });
  } catch {
    return '';
  }
};

const reasonLabel = (r, t) => {
  const map = {
    earn_buy_in: t('loyalty.reasonBuyIn', 'Buy-in'),
    earn_rebuy: t('loyalty.reasonRebuy', 'Rebuy'),
    earn_addon: t('loyalty.reasonAddon', 'Add-on'),
    redeem: t('loyalty.reasonRedeem', 'Resgate'),
    cashback: t('loyalty.reasonCashback', 'Cashback'),
    birthday: t('loyalty.reasonBirthday', 'Aniversário'),
    goal: t('loyalty.reasonGoal', 'Meta'),
    coupon: t('loyalty.reasonCoupon', 'Cupom'),
    manual: t('loyalty.reasonManual', 'Ajuste'),
  };
  return map[r] || r;
};

const isBirthdayToday = (iso) => {
  if (!iso) return false;
  const d = new Date(iso + 'T00:00:00');
  const now = new Date();
  return d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

export default function PlayerLoyaltyCard({
  data, t, locale, formatCurrency, onRedeem, onConvertCashback,
  onRedeemCoupon, onClaimGoal, onGiftCredit, birthDate, busy,
}) {
  const [coupon, setCoupon] = useState('');
  if (!data) return null;
  const {
    account, tier, next_tier, lifetime_points, ledger = [],
    cashback_balance = 0, rewards = [], goals = [], giftable_credits = [],
  } = data;
  const birthdayToday = isBirthdayToday(birthDate);
  const balance = account?.points_balance ?? 0;
  const fmtMoney = typeof formatCurrency === 'function' ? formatCurrency : (n) => `R$ ${Number(n || 0).toFixed(2)}`;

  const submitCoupon = (e) => {
    e.preventDefault();
    const code = coupon.trim();
    if (code && onRedeemCoupon) { onRedeemCoupon(code); setCoupon(''); }
  };
  const lifetime = lifetime_points ?? 0;
  const tierColor = tier?.color || 'var(--accent-color, #7233f8)';

  // Progresso para o próximo nível (dos pontos vitalícios).
  const base = tier ? Number(tier.min_points || 0) : 0;
  const target = next_tier ? Number(next_tier.min_points) : null;
  const pct = target && target > base
    ? Math.max(0, Math.min(100, ((lifetime - base) / (target - base)) * 100))
    : 100;

  return (
    <div className="plc-card">
      <div className="plc-head">
        <h2 className="plc-title">{t('loyalty.title', 'Fidelidade')}</h2>
        <div className="plc-head-badges">
          {birthdayToday && (
            <span className="plc-birthday">🎂 {t('loyalty.birthdayToday', 'Aniversário hoje!')}</span>
          )}
          {tier && (
            <span className="plc-tier" style={{ '--tier-color': tierColor }}>
              <span className="plc-tier-dot" />
              {tier.name}
            </span>
          )}
        </div>
      </div>

      <div className="plc-body">
        <div className="plc-balance">
          <span className="plc-balance-value">{fmtPts(balance)}</span>
          <span className="plc-balance-label">{t('loyalty.points', 'pontos')}</span>
        </div>

        <div className="plc-progress-wrap">
          <div className="plc-progress-meta">
            {next_tier ? (
              <>
                <span>{t('loyalty.toNext', 'Faltam {{n}} pts para {{tier}}', {
                  n: fmtPts(Math.max(0, (target || 0) - lifetime)),
                  tier: next_tier.name,
                })}</span>
                <span className="plc-progress-pct">{Math.round(pct)}%</span>
              </>
            ) : (
              <span>{t('loyalty.maxTier', 'Nível máximo alcançado')}</span>
            )}
          </div>
          <div className="plc-progress-bar">
            <div className="plc-progress-fill" style={{ width: `${pct}%`, background: tierColor }} />
          </div>
          <div className="plc-progress-sub">
            {t('loyalty.lifetime', '{{n}} pts acumulados no total', { n: fmtPts(lifetime) })}
          </div>
        </div>
      </div>

      {/* Cashback */}
      {Number(cashback_balance) > 0 && (
        <div className="plc-cashback">
          <div className="plc-cashback-info">
            <span className="plc-cashback-label">{t('loyalty.cashbackBalance', 'Cashback disponível')}</span>
            <span className="plc-cashback-value">{fmtMoney(cashback_balance)}</span>
          </div>
          <button className="plc-btn" onClick={onConvertCashback} disabled={busy} type="button">
            {t('loyalty.convertCashback', 'Converter em crédito')}
          </button>
        </div>
      )}

      {/* Créditos presenteáveis (aniversário / indicação) */}
      {giftable_credits.length > 0 && (
        <div className="plc-gifts">
          <div className="plc-ledger-title">{t('loyalty.giftable', 'Créditos para presentear')}</div>
          <ul className="plc-rewards-list">
            {giftable_credits.map((c) => (
              <li key={c.id} className="plc-reward">
                <div className="plc-reward-info">
                  <span className="plc-reward-name">{fmtMoney(c.original_amount)}</span>
                  <span className="plc-reward-cost">{c.notes || t('loyalty.credit', 'Crédito')}</span>
                </div>
                <button
                  className="plc-btn small"
                  onClick={() => onGiftCredit && onGiftCredit(c)}
                  disabled={busy}
                  type="button"
                >
                  {t('loyalty.gift', 'Presentear')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recompensas */}
      {rewards.length > 0 && (
        <div className="plc-rewards">
          <div className="plc-ledger-title">{t('loyalty.rewards', 'Recompensas')}</div>
          <ul className="plc-rewards-list">
            {rewards.map((r) => {
              const affordable = balance >= Number(r.cost_points);
              return (
                <li key={r.id} className="plc-reward">
                  <div className="plc-reward-info">
                    <span className="plc-reward-name">{r.name}</span>
                    <span className="plc-reward-cost">{fmtPts(r.cost_points)} {t('loyalty.points', 'pontos')}</span>
                  </div>
                  <button
                    className="plc-btn small"
                    onClick={() => onRedeem && onRedeem(r.id)}
                    disabled={busy || !affordable}
                    title={affordable ? '' : t('loyalty.notEnough', 'Pontos insuficientes')}
                    type="button"
                  >
                    {t('loyalty.redeem', 'Resgatar')}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Metas / desafios */}
      {goals.length > 0 && (
        <div className="plc-goals">
          <div className="plc-ledger-title">{t('loyalty.goals', 'Metas do mês')}</div>
          {goals.map((g) => {
            const pct = Math.max(0, Math.min(100, (Number(g.progress) / Number(g.target || 1)) * 100));
            return (
              <div key={g.id} className="plc-goal">
                <div className="plc-goal-head">
                  <span className="plc-goal-name">{g.name}</span>
                  <span className="plc-goal-count">
                    {Math.floor(Number(g.progress))}/{Number(g.target)}
                    <span className="plc-goal-reward"> · +{fmtPts(g.reward_points)} pts</span>
                  </span>
                </div>
                <div className="plc-goal-bar">
                  <div className="plc-goal-fill" style={{ width: `${pct}%` }} />
                </div>
                {g.claimed ? (
                  <span className="plc-goal-claimed">✓ {t('loyalty.claimed', 'Resgatada')}</span>
                ) : g.completed ? (
                  <button className="plc-btn small" onClick={() => onClaimGoal && onClaimGoal(g.id)} disabled={busy} type="button">
                    {t('loyalty.claim', 'Resgatar recompensa')}
                  </button>
                ) : (
                  <span className="plc-goal-progresslabel">{Math.round(pct)}%</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Cupom */}
      <form className="plc-coupon" onSubmit={submitCoupon}>
        <input
          className="plc-coupon-input"
          value={coupon}
          onChange={(e) => setCoupon(e.target.value)}
          placeholder={t('loyalty.couponPlaceholder', 'Código do cupom')}
          disabled={busy}
        />
        <button className="plc-btn" type="submit" disabled={busy || !coupon.trim()}>
          {t('loyalty.applyCoupon', 'Aplicar')}
        </button>
      </form>

      {ledger.length > 0 && (
        <div className="plc-ledger">
          <div className="plc-ledger-title">{t('loyalty.recent', 'Movimentações recentes')}</div>
          <ul className="plc-ledger-list">
            {ledger.slice(0, 6).map((e) => (
              <li key={e.id} className="plc-ledger-item">
                <span className="plc-ledger-reason">{reasonLabel(e.reason, t)}</span>
                <span className="plc-ledger-date">{fmtDate(e.created_at, locale)}</span>
                <span className={`plc-ledger-delta ${Number(e.delta) >= 0 ? 'pos' : 'neg'}`}>
                  {Number(e.delta) >= 0 ? '+' : ''}{fmtPts(e.delta)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
