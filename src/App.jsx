import { useState } from "react";
import PrivacyLedger from "./components/PrivacyLedger";
import "./App.css";

function App() {
  const [task, setTask] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [activity, setActivity] = useState([]);

  const handleStart = () => {
    if (!task.trim()) {
      setActivity((prev) => [
        "Please enter a task first.",
        ...prev,
      ]);
      return;
    }

    setIsRunning(true);

    setActivity((prev) => [
      `Task started: ${task}`,
      "Agent is preparing the browser action...",
      ...prev,
    ]);

    setTimeout(() => {
      setActivity((prev) => [
        "Task is being processed.",
        ...prev,
      ]);
    }, 1000);
  };

  return (
    <div className="app-container">

      {/* Plugin Popup */}
      <div className="agent-popup">

        {/* Header */}
        <header className="popup-header">
          <div>
            <div className="brand-row">
              <div className="brand-mark">SA</div>

              <div>
                <h1>SIH2026 PS171</h1>
                <p>Browser Agent</p>
              </div>
            </div>
          </div>

          <div className="status-indicator">
            <span
              className={`status-dot ${
                isRunning ? "running" : ""
              }`}
            ></span>

            <span>
              {isRunning ? "Running" : "Ready"}
            </span>
          </div>
        </header>

        {/* Orange Accent Line */}
        <div className="orange-line"></div>

        {/* Task Section */}
        <section className="task-section">

          <div className="section-title">
            <span className="orange-marker"></span>
            <span>Task Description</span>
          </div>

          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="e.g. Fill the form with test data and submit"
            className="task-input"
          />

          <button
            className="start-button"
            onClick={handleStart}
          >
            <span className="button-icon">▶</span>
            Start Agent
          </button>

        </section>

        {/* Activity Log */}
        <section className="activity-section">

          <div className="section-heading">
            <span>Activity Log</span>

            <span className="live-label">
              <span className="live-dot"></span>
              LIVE
            </span>
          </div>

          <div className="activity-log">

            {activity.length === 0 ? (
              <div className="empty-log">
                No activity yet
              </div>
            ) : (
              activity.map((item, index) => (
                <div
                  className="activity-item"
                  key={index}
                >
                  <span className="activity-time">
                    {new Date().toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>

                  <span className="activity-text">
                    {item}
                  </span>
                </div>
              ))
            )}

          </div>

        </section>

        {/* Privacy Ledger */}
        <PrivacyLedger />

        {/* Footer */}
        <footer className="popup-footer">

          <div className="footer-status">
            <span className="green-dot"></span>

            <span>
              Privacy protection active
            </span>
          </div>

          <span className="version">
            v1.0
          </span>

        </footer>

      </div>

    </div>
  );
}

export default App;