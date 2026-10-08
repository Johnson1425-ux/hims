'use client';

/**
 * Form building blocks.
 *
 * Three things here that a plain <form> does not give you, and that every
 * screen in this system needs identically:
 *
 *  1. SERVER ISSUES LAND ON FIELDS. The API returns `issues: [{field, message}]`
 *     and the browser should mark up the field rather than printing a sentence
 *     at the top and leaving the user to find it. `useFormErrors` maps them.
 *
 *  2. A DIALOG THAT BEHAVES. Focus moves in, Escape closes, the background does
 *     not scroll, and the heading is wired to aria-labelledby — a clinician on
 *     a keyboard in a gloved hurry should not have to hunt for the field.
 *
 *  3. ONE SUBMISSION AT A TIME. A double-tapped "Dispense" or "Record payment"
 *     on a laggy ward tablet must not produce two of them.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '@/lib/api';
import { Alert, Button } from './primitives';

/* ---------------------------------------------------------------------------
 * Field errors from the API
 * ------------------------------------------------------------------------- */

export interface FormState {
  errors: Record<string, string>;
  message: string | null;
  submitting: boolean;
}

export function useFormErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);

  const reset = useCallback(() => {
    setErrors({});
    setMessage(null);
  }, []);

  /**
   * Field-level issues are attached to their fields; anything without a field
   * — a conflict, a business rule — becomes the form-level message, because a
   * message with nowhere to attach must not disappear.
   *
   * `rendered` IS THE GUARD AGAINST A SILENT FORM. Suppressing the message
   * assumes the field errors will be seen, and an issue naming a field this
   * form does not render is seen nowhere at all: the user presses the button
   * and watches nothing happen. That shipped — the API reported password
   * policy failures against `password` while the form rendered
   * `newPassword`. Pass the names a form actually renders and any issue
   * outside that set keeps the message visible instead.
   */
  const capture = useCallback((error: unknown, rendered?: readonly string[]) => {
    if (error instanceof ApiError) {
      setErrors(error.fieldErrors);

      const fields = Object.keys(error.fieldErrors);
      const allShown =
        fields.length > 0 && (rendered === undefined || fields.every((f) => rendered.includes(f)));

      setMessage(error.issues.length > 0 && allShown ? null : error.message);
      return;
    }
    setErrors({});
    setMessage('Something went wrong. Please try again.');
  }, []);

  return { errors, message, setMessage, reset, capture };
}

/* ---------------------------------------------------------------------------
 * Labelled controls
 * ------------------------------------------------------------------------- */

function Shell({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
}: {
  label?: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="w-full">
      {label ? (
        <label
          htmlFor={htmlFor}
          className="mb-1.5 block text-[0.8125rem] font-medium"
          style={{ color: 'var(--ink-secondary)' }}
        >
          {label}
          {required ? (
            <span className="ml-1" style={{ color: 'var(--critical-ink)' }} aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1.5 text-[0.75rem]" style={{ color: 'var(--critical-ink)' }}>
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const controlStyle = (invalid: boolean) => ({
  background: 'var(--surface)',
  color: 'var(--ink)',
  border: `1px solid ${invalid ? 'var(--critical)' : 'var(--line-strong)'}`,
});

export function Field({
  name,
  label,
  error,
  hint,
  required,
  type = 'text',
  ...rest
}: {
  name: string;
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  type?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'type'>): ReactNode {
  return (
    <Shell label={label} htmlFor={name} error={error} hint={hint} required={required}>
      <input
        id={name}
        name={name}
        type={type}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined}
        className="h-9.5 w-full rounded-[var(--radius-md)] px-3 text-[0.875rem]"
        style={controlStyle(Boolean(error))}
        {...rest}
      />
    </Shell>
  );
}

export function Select({
  name,
  label,
  error,
  hint,
  required,
  options,
  placeholder,
  ...rest
}: {
  name: string;
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  options: Array<{ value: string; label: string }>;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'name'>): ReactNode {
  return (
    <Shell label={label} htmlFor={name} error={error} hint={hint} required={required}>
      <select
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined}
        className="h-9.5 w-full rounded-[var(--radius-md)] px-3 text-[0.875rem]"
        style={controlStyle(Boolean(error))}
        {...rest}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function TextArea({
  name,
  label,
  error,
  hint,
  required,
  rows = 4,
  ...rest
}: {
  name: string;
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  rows?: number;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'name' | 'rows'>): ReactNode {
  return (
    <Shell label={label} htmlFor={name} error={error} hint={hint} required={required}>
      <textarea
        id={name}
        name={name}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : hint ? `${name}-hint` : undefined}
        className="w-full rounded-[var(--radius-md)] px-3 py-2 text-[0.875rem] leading-relaxed"
        style={controlStyle(Boolean(error))}
        {...rest}
      />
    </Shell>
  );
}

export function Checkbox({
  name,
  label,
  hint,
  ...rest
}: {
  name: string;
  label: string;
  hint?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'type'>): ReactNode {
  return (
    <div>
      <label className="flex items-start gap-2.5 text-[0.875rem]" style={{ color: 'var(--ink)' }}>
        <input id={name} name={name} type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" {...rest} />
        <span>{label}</span>
      </label>
      {hint ? (
        <p className="mt-1 ml-6.5 text-[0.75rem]" style={{ color: 'var(--ink-muted)' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A labelled group, so a long form reads as sections rather than a wall. */
export function FieldSet({
  legend,
  description,
  children,
  columns = 2,
}: {
  legend: string;
  description?: string;
  children: ReactNode;
  columns?: 1 | 2 | 3;
}): ReactNode {
  const grid = columns === 1 ? '' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3';

  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-[0.9375rem] font-semibold" style={{ color: 'var(--ink)' }}>
        {legend}
      </legend>
      {description ? (
        <p className="mb-3 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
          {description}
        </p>
      ) : (
        <div className="mb-3" />
      )}
      <div className={`grid gap-4 ${grid}`}>{children}</div>
    </fieldset>
  );
}

/* ---------------------------------------------------------------------------
 * Dialog
 * ------------------------------------------------------------------------- */

interface DialogContextValue {
  titleId: string;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = '34rem',
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  /**
   * A class for the portal root. A dialog mounts on `document.body`, OUTSIDE
   * whatever subtree opened it, so a caller that redefines design tokens on a
   * wrapper — the platform console remaps the accent onto its vendor amber —
   * loses them here and renders a dialog in the wrong palette. Passing that
   * wrapper's class back in is what carries the scope across the portal.
   */
  className?: string;
}): ReactNode {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    // `mounted` is in the dependencies, not just `open`, because the portal
    // does not exist on the first render. A Dialog that its parent mounts
    // ALREADY OPEN — the pattern where the parent returns null until there
    // is something to show — ran this effect once against an empty ref, found
    // no control to focus, and never ran again: the dialog opened with focus
    // still on the button behind it. Tab was trapped correctly, so it only
    // showed up as "the first Tab goes somewhere odd".
    if (!open || !mounted) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    // Focus the first control rather than the panel, so typing starts
    // immediately — this is a form, and the user came here to fill it in.
    //
    // Fields are preferred over buttons rather than simply taking the first
    // of either in document order: a dialog that opens with a row of actions
    // above its fields would otherwise start on "Open the PDF" instead of on
    // the amount the operator came here to type.
    const field = panel.current?.querySelector<HTMLElement>('input, select, textarea');
    const button = panel.current?.querySelector<HTMLElement>(
      'button:not([data-dialog-close])',
    );
    (field ?? button ?? panel.current)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }

      // Keep Tab inside the dialog: behind it is a patient list that must not
      // be reachable while a modal decision is open.
      if (event.key !== 'Tab' || !panel.current) return;

      const focusable = [
        ...panel.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.offsetParent !== null);

      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [open, mounted, onClose]);

  const value = useMemo(() => ({ titleId }), [titleId]);

  if (!open || !mounted) return null;

  return createPortal(
    <DialogContext.Provider value={value}>
      <div
        className={`fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8${className ? ` ${className}` : ''}`}
        style={{ background: 'color-mix(in srgb, var(--ink) 45%, transparent)' }}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="w-full rounded-[var(--radius-lg)] shadow-xl outline-none"
          style={{
            maxWidth: width,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
          }}
        >
          <div className="flex items-start justify-between gap-4 p-5 pb-0">
            <div>
              <h2 id={titleId} className="text-[1.125rem] font-semibold" style={{ color: 'var(--ink)' }}>
                {title}
              </h2>
              {description ? (
                <p className="mt-1 text-[0.8125rem]" style={{ color: 'var(--ink-muted)' }}>
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              data-dialog-close
              aria-label="Close"
              onClick={onClose}
              className="-mt-1 -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[1.25rem] leading-none"
              style={{ color: 'var(--ink-muted)' }}
            >
              ×
            </button>
          </div>

          <div className="p-5">{children}</div>

          {footer ? (
            <div
              className="flex flex-wrap items-center justify-end gap-2 p-5 pt-4"
              style={{ borderTop: '1px solid var(--line)' }}
            >
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </DialogContext.Provider>,
    document.body,
  );
}

/**
 * A dialog whose body is a form.
 *
 * `submitting` is owned here rather than by each caller, because the thing it
 * prevents — a second submission of an action that moves stock or takes money —
 * is the same everywhere and too easy to leave out.
 */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  submitTone = 'primary',
  onSubmit,
  message,
  children,
  width,
  disabled,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel: string;
  submitTone?: 'primary' | 'danger';
  onSubmit: () => Promise<void>;
  message?: string | null;
  children: ReactNode;
  width?: string;
  disabled?: boolean;
  /** Passed through to `Dialog` — see the note there. */
  className?: string;
}): ReactNode {
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    try {
      await onSubmit();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={submitting ? () => undefined : onClose}
      title={title}
      description={description}
      width={width}
      className={className}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="dialog-form"
            variant={submitTone}
            loading={submitting}
            disabled={submitting || disabled}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id="dialog-form" onSubmit={submit} className="flex flex-col gap-5">
        {message ? <Alert tone="critical">{message}</Alert> : null}
        {children}
      </form>
    </Dialog>
  );
}

export function useDialogTitleId(): string | null {
  return useContext(DialogContext)?.titleId ?? null;
}
