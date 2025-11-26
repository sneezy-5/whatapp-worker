/**
 * Validator utility for validating data
 */

/**
 * Validate phone number format
 */
export function isValidPhoneNumber(phoneNumber) {
  if (!phoneNumber) return false;
  
  // Remove all non-numeric characters
  const cleaned = phoneNumber.replace(/[^0-9]/g, '');
  
  // Must have at least 10 digits
  return cleaned.length >= 10 && cleaned.length <= 15;
}

/**
 * Validate email format
 */
export function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate message type
 */
export function isValidMessageType(type) {
  const validTypes = ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO', 'LOCATION'];
  return validTypes.includes(type?.toUpperCase());
}

/**
 * Validate URL format
 */
export function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate message data
 */
export function validateMessageData(data) {
  const errors = [];

  if (!data.recipientNumber) {
    errors.push('recipientNumber is required');
  } else if (!isValidPhoneNumber(data.recipientNumber)) {
    errors.push('recipientNumber is invalid');
  }

  if (!data.content && !data.mediaUrl) {
    errors.push('Either content or mediaUrl is required');
  }

  if (data.type && !isValidMessageType(data.type)) {
    errors.push('Invalid message type');
  }

  if (data.mediaUrl && !isValidUrl(data.mediaUrl)) {
    errors.push('mediaUrl is invalid');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate session data
 */
export function validateSessionData(data) {
  const errors = [];

  if (!data.numberId) {
    errors.push('numberId is required');
  }

  if (!data.phoneNumber) {
    errors.push('phoneNumber is required');
  } else if (!isValidPhoneNumber(data.phoneNumber)) {
    errors.push('phoneNumber is invalid');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export default {
  isValidPhoneNumber,
  isValidEmail,
  isValidMessageType,
  isValidUrl,
  validateMessageData,
  validateSessionData,
};