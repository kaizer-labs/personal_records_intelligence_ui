import { useEffect, useState } from "react";

type HealthPayload = {
  status: string;
  service: string;
  version: string;
  environment: string;
  database: {
    status: string;
    engine: string;
    version: string;
    path: string;
    table_count: number;
  };
};

function App() {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadHealth = async () => {
      try {
        const response = await fetch("/health_check");

        if (!response.ok) {
          throw new Error(`Health check failed with status ${response.status}`);
        }

        const payload = (await response.json()) as HealthPayload;
        setHealth(payload);
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to reach the backend.";
        setError(message);
      } finally {
        setLoading(false);
      }
    };

    void loadHealth();
  }, []);

  return (
    <main className="app-shell">
      <section className="hero-card">
        <p className="eyebrow">Personal Records Intelligence</p>
        <h1>FastAPI and React starter</h1>
        <p className="lede">
          This UI is wired to the backend health endpoint so we can validate the
          local stack before building ingestion and query flows.
        </p>
      </section>

      <section className="status-card">
        <h2>Backend health</h2>

        {loading && <p className="status-pill pending">Checking backend...</p>}

        {!loading && error && <p className="status-pill error">{error}</p>}

        {!loading && health && (
          <>
            <div className="health-grid">
              <div>
                <span className="label">Status</span>
                <strong>{health.status}</strong>
              </div>
              <div>
                <span className="label">Service</span>
                <strong>{health.service}</strong>
              </div>
              <div>
                <span className="label">Version</span>
                <strong>{health.version}</strong>
              </div>
              <div>
                <span className="label">Environment</span>
                <strong>{health.environment}</strong>
              </div>
            </div>

            <div className="database-panel">
              <div className="database-heading">
                <h3>DuckDB status</h3>
                <span className="status-pill success">{health.database.status}</span>
              </div>

              <div className="health-grid">
                <div>
                  <span className="label">Engine</span>
                  <strong>{health.database.engine}</strong>
                </div>
                <div>
                  <span className="label">Version</span>
                  <strong>{health.database.version}</strong>
                </div>
                <div>
                  <span className="label">Table count</span>
                  <strong>{health.database.table_count}</strong>
                </div>
              </div>

              <div className="path-card">
                <span className="label">Database file</span>
                <strong>{health.database.path}</strong>
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export default App;
