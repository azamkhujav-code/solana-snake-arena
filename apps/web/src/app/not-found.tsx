import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div>
        <h1 className="mb-2 text-3xl font-bold">404</h1>
        <p className="mb-6 text-slate-400">That arena does not exist.</p>
        <Link href="/" className="text-emerald-400 hover:text-emerald-300">
          Back to lobby
        </Link>
      </div>
    </main>
  );
}
