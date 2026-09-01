import React, { useState } from "react";
import "./PrivacyLedger.css";

const initialEvents = [
  {
    id: 1,
    time: "23:14:15",
    type: "PASSWORD",
    status: "REDACTED",
    confidence: "99%",
    hash: "66b7fc",
    message: "Password field redacted locally",
  },
  {
    id: 2,
    time: "23:14:11",
    type: "PHONE",
    status: "DETECTED",
    confidence: "93%",
    hash: "377db8",
    message: "PII detected — inspection required",
  },
  {
    id: 3,
    time: "23:14:07",
    type: "EMAIL",
    status: "ALLOWED",
    confidence: "98%",
    hash: "415c63",
    message: "Allowed — clean data",
  },
  {
    id: 4,
    time: "23:14:03",
    type: "CARD",
    status: "BLOCKED",
    confidence: "97%",
    hash: "e58656",
    message: "Blocked — sensitive data prevented from egress",
  },
  {
    id: 5,
    time: "23:13:59",
    type: "PASSWORD",
    status: "REDACTED",
    confidence: "99%",
    hash: "a5e72f",
    message: "Password field redacted locally",
  },
  {
    id: 6,
    time: "23:13:55",
    type: "PHONE",
    status: "DETECTED",
    confidence: "93%",
    hash: "d7a7d8",
    message: "PII detected — inspection required",
  },
  {
    id: 7,
    time: "23:13:51",
    type: "EMAIL",
    status: "ALLOWED",
    confidence: "98%",
    hash: "18c671",
    message: "Allowed — clean data",
  },
  {
    id: 8,
    time: "23:13:47",
    type: "CARD",
    status: "BLOCKED",
    confidence: "97%",
    hash: "9ae87a",
    message: "Blocked — sensitive data prevented from egress",
  },
  {
    id: 9,
    time: "23:13:42",
    type: "PASSWORD",
    status: "REDACTED",
    confidence: "99%",
    hash: "c30f6e",
    message: "Password field redacted locally",
  },
  {
    id: 10,
    time: "23:13:38",
    type: "PHONE",
    status: "DETECTED",
    confidence: "93%",
    hash: "7a7d08",
    message: "PII detected — inspection required",
  },
];

function PrivacyLedger() {
  const [events] = useState(initialEvents);

  const allowedCount = events.filter(
    (event) => event.status === "ALLOWED"
  ).length;

  const warningCount = events.filter(
    (event) => event.status === "DETECTED"
  ).length;

  const blockedCount = events.filter(
    (event) => event.status === "BLOCKED"
  ).length;

  const redactedCount = events.filter(
    (event) => event.status === "REDACTED"
  ).length;

  const exportJSON = () => {
    const data = {
      protection: "Active",
      timestamp: new Date().toISOString(),
      totalEvents: events.length,
      allowed: allowedCount,
      warnings: warningCount,
      blocked: blockedCount,
      redacted: redactedCount,
      events: events,
    };

    const blob = new Blob(
      [JSON.stringify(data, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "privacy-ledger.json";

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  };

  return (
    <section className="privacy-ledger">
      {/* Header */}
      <div className="ledger-header">
        <div>
          <div className="ledger-title-row">
            <span className="lock-icon">🔒</span>

            <div>
              <h2>Privacy Ledger</h2>
              <p>Real-time privacy & PII audit trail</p>
            </div>
          </div>
        </div>

        <div className="protection-badge">
          <span className="protection-dot"></span>
          Protection Active
        </div>
      </div>

      {/* Export Button */}
      <button className="export-button" onClick={exportJSON}>
        <span>↓</span>
        Export JSON
      </button>

      {/* Statistics */}
      <div className="ledger-stats">
        <div className="stat-card">
          <span className="stat-label">Nonce</span>
          <strong>#1204</strong>
        </div>

        <div className="stat-card">
          <span className="stat-label">Events</span>
          <strong>{events.length}</strong>
        </div>

        <div className="stat-card stat-success">
          <span className="stat-label">Allowed</span>
          <strong>{allowedCount}</strong>
        </div>

        <div className="stat-card stat-warning">
          <span className="stat-label">Warnings</span>
          <strong>{warningCount}</strong>
        </div>

        <div className="stat-card stat-danger">
          <span className="stat-label">Blocked</span>
          <strong>{blockedCount}</strong>
        </div>
      </div>

      {/* Live Audit Stream */}
      <div className="audit-section">
        <div className="audit-header">
          <div>
            <h3>LIVE AUDIT STREAM</h3>
            <p>Real-time privacy events detected by VisionAgent</p>
          </div>

          <span className="live-indicator">
            <span></span>
            LIVE
          </span>
        </div>

        {/* Events */}
        <div className="audit-list">
          {events.map((event) => (
            <div className="audit-event" key={event.id}>
              {/* Time */}
              <div className="event-time">
                {event.time}
              </div>

              {/* Event Icon */}
              <div
                className={`event-icon ${event.status.toLowerCase()}`}
              >
                {event.type === "PASSWORD" && "🔑"}
                {event.type === "PHONE" && "📱"}
                {event.type === "EMAIL" && "✉"}
                {event.type === "CARD" && "💳"}
              </div>

              {/* Main Event */}
              <div className="event-content">
                <div className="event-top">
                  <span className="event-type">
                    {event.type}
                  </span>

                  <span
                    className={`event-status ${event.status.toLowerCase()}`}
                  >
                    {event.status}
                  </span>
                </div>

                <p>{event.message}</p>

                <div className="event-meta">
                  <span>
                    Confidence <strong>{event.confidence}</strong>
                  </span>

                  <span>
                    Hash <strong>#{event.hash}</strong>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="ledger-footer">
        <div>
          <span className="footer-dot"></span>
          All privacy events are processed locally
        </div>

        <span>VisionAgent Security Layer</span>
      </div>
    </section>
  );
}

export default PrivacyLedger;