import "./App.css";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

function App() {
  const totals = useQuery(api.example.getTotals, {});
  const status = useQuery(api.example.workerStatus, {});
  const addEvent = useMutation(api.example.addEvent);
  const [value, setValue] = useState("1");

  const enqueue = (n: number) => addEvent({ value: n });

  return (
    <>
      <h1>Batch Worker demo</h1>
      <div className="card">
        <p style={{ lineHeight: 1.6 }}>
          Each event you add is inserted into a queue table. After inserting we
          call <code>ping</code>, and the component runs a single background loop
          that batches the events and sums them — restarting itself if it ever
          dies, and going idle when the queue drains.
        </p>

        <div style={{ display: "flex", gap: "0.5rem", margin: "1rem 0" }}>
          <input
            type="number"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={{ width: "6rem" }}
          />
          <button onClick={() => enqueue(Number(value) || 0)}>Add event</button>
          <button
            onClick={() => Array.from({ length: 25 }, (_, i) => enqueue(i + 1))}
          >
            Add 25 events
          </button>
        </div>

        <ul>
          <li>
            Worker status: <strong>{status?.kind ?? "never run"}</strong>
          </li>
          <li>
            Events processed: <strong>{totals?.count ?? 0}</strong>
          </li>
          <li>
            Running total: <strong>{totals?.total ?? 0}</strong>
          </li>
        </ul>

        <p>
          See <code>example/convex/example.ts</code> for the work query and
          worker mutation that drive this.
        </p>
      </div>
    </>
  );
}

export default App;
