import React from 'react';

export const brandMarkSrc = '/brand/dachbyte/business/mark-transparent.png';
export const brandLogoSrc = brandMarkSrc;

const BrandLogo = ({ subtitle = 'Workspace corporativo', showText = true, className = '', textClassName = '' }) => (
  <span className={`brand-lockup ${className}`.trim()}>
    <span className="dachbyte-signature__wordmark" aria-label="DACHBYTE"><span>DACH</span><span>BYTE</span></span>
    {showText && subtitle && (
      <span className={`brand-copy ${textClassName}`.trim()}>
        <small>{subtitle}</small>
      </span>
    )}
  </span>
);

export default BrandLogo;
