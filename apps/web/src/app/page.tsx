'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';

/** Entry point: route to the workspace or to sign-in once the session resolves. */
export default function IndexPage() {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === 'authenticated') router.replace('/dashboard');
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  return (
    <div className="flex min-h-screen items-center justify-center" style={{ background: 'var(--page)' }}>
      <p className="text-[0.875rem]" style={{ color: 'var(--ink-muted)' }}>
        Loading…
      </p>
    </div>
  );
}
