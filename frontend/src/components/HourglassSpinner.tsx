'use client';

import { useId } from 'react';
import styles from './HourglassSpinner.module.css';

type HourglassSpinnerProps = {
  className?: string;
  title?: string;
};

export default function HourglassSpinner({ className = '', title }: HourglassSpinnerProps) {
  const ariaLabel = title || 'Processing';
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const topChamberId = `hgTopChamber-${uid}`;
  const bottomChamberId = `hgBottomChamber-${uid}`;

  return (
    <span className={`${styles.root} ${className}`} aria-hidden={title ? undefined : true} title={title}>
      <svg
        className={styles.svg}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role={title ? 'img' : 'presentation'}
        aria-label={title ? ariaLabel : undefined}
      >
        <defs>
          <clipPath id={topChamberId}>
            <polygon points="8.5,6.5 15.5,6.5 12,10.5" />
          </clipPath>
          <clipPath id={bottomChamberId}>
            <polygon points="12,13.5 8.5,17.5 15.5,17.5" />
          </clipPath>
        </defs>

        {/* Outline */}
        <path
          d="M7 2h10v4l-4 4v4l4 4v4H7v-4l4-4v-4L7 6V2z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />

        {/* Sand (top drains, bottom fills) */}
        <g clipPath={`url(#${topChamberId})`}>
          <rect className={styles.sandTop} x="8.5" y="6.5" width="7" height="4.2" fill="currentColor" />
        </g>
        <g clipPath={`url(#${bottomChamberId})`}>
          <rect className={styles.sandBottom} x="8.5" y="13.3" width="7" height="4.4" fill="currentColor" />
        </g>

        {/* Sand stream */}
        <rect
          className={styles.stream}
          x="11.5"
          y="10.3"
          width="1"
          height="3.5"
          rx="0.5"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}
