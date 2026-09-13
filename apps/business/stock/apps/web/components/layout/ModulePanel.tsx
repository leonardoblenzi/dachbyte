import type { LucideIcon } from 'lucide-react';

type ModulePanelProps = {
  title: string;
  icon: LucideIcon;
  rows: Array<{ label: string; value: string; status: string }>;
};

export function ModulePanel({ title, icon: Icon, rows }: ModulePanelProps) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        <Icon size={18} aria-hidden="true" />
      </div>
      <div className="module-list">
        {rows.map((row) => (
          <article key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
            <small>{row.status}</small>
          </article>
        ))}
      </div>
    </section>
  );
}
