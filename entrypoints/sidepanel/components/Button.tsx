import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Full-width, 48px tall (footer actions). */
  block?: boolean;
}

export function Button({ variant = 'primary', block, className, type = 'button', ...rest }: ButtonProps) {
  const cls = ['btn', `btn-${variant}`, block && 'btn-block', className].filter(Boolean).join(' ');
  return <button type={type} className={cls} {...rest} />;
}
