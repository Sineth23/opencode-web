#!/usr/bin/env node
// Simple test to verify token flow

const token = localStorage.getItem('cognito_id_token');
console.log('Token from localStorage:', token ? `${token.substring(0, 50)}...` : 'NOT FOUND');

if (token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    console.log('Token claims:', {
      sub: payload.sub,
      email: payload.email,
      'cognito:username': payload['cognito:username'],
      iss: payload.iss,
      aud: payload.aud,
    });
  } catch (e) {
    console.error('Failed to parse token:', e.message);
  }
}

// Test making a request
const apiUrl = 'https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com';
console.log('\nMaking test request to:', `${apiUrl}/whoami`);
console.log('Authorization header will be:', token ? `Bearer ${token.substring(0, 20)}...` : 'NOT SET');
