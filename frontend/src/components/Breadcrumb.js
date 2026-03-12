import React from 'react';
import { Link } from 'react-router-dom';
import './Breadcrumb.css';

/**
 * Breadcrumb component (A6.4)
 * @param {Array} items - [{ label, to }] — last item has no `to` (current page)
 */
const Breadcrumb = ({ items }) => (
  <nav className="breadcrumb" aria-label="Breadcrumb">
    {items.map((item, i) => {
      const isLast = i === items.length - 1;
      return (
        <React.Fragment key={i}>
          {i > 0 && <span className="breadcrumb-sep">›</span>}
          {isLast ? (
            <span className="breadcrumb-current" aria-current="page">
              {item.label}
            </span>
          ) : (
            <Link to={item.to} className="breadcrumb-link">
              {item.label}
            </Link>
          )}
        </React.Fragment>
      );
    })}
  </nav>
);

export default Breadcrumb;
