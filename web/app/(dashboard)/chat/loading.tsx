export default function ChatLoading() {
  return (
    <div className="mx-auto max-w-[780px] h-[calc(100vh-theme(spacing.16))] flex flex-col items-center justify-center">
      <div className="h-12 w-12 rounded-xl bg-zinc-900 animate-pulse" />
      <div className="mt-4 h-5 w-40 rounded bg-zinc-900 animate-pulse" />
      <div className="mt-2 h-4 w-64 rounded bg-zinc-900/60 animate-pulse" />
    </div>
  );
}
