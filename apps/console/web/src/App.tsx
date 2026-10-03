export function App() {
  return (
    <main>
      <h1 className="t-display">The World’s Worst Website</h1>
      <div style={{ display: 'flex' }}>
        {(['sense', 'triage', 'plan', 'build', 'gates', 'review', 'release', 'verify'] as const).map((kind) => (
          <sf-station key={kind} kind={kind} status="idle" />
        ))}
      </div>
    </main>
  );
}
