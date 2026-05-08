// Test script to verify the authentication flow
// Run this in the browser console after logging in

console.log('=== Authentication Integration Test ===\n');

// Test 1: Check if token is in localStorage
const token = localStorage.getItem('cognito_id_token');
console.log('1. Token in localStorage?', !!token);
if (token) {
  console.log('   Token length:', token.length);
  console.log('   Token preview:', token.substring(0, 50) + '...');

  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    console.log('   Token claims:');
    console.log('   - sub (userId):', payload.sub);
    console.log('   - email:', payload.email);
    console.log('   - issuer:', payload.iss);
  } catch (e) {
    console.error('   Failed to decode token:', e.message);
  }
} else {
  console.warn('   ❌ No token found - try logging in first');
}

// Test 2: Verify custom fetch logic
console.log('\n2. Testing custom fetch function:');
const testFetch = async (url, options = {}) => {
  const token = localStorage.getItem('cognito_id_token');
  if (token) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    options.headers = headers;
  }
  return fetch(url, options);
};

console.log('   Custom fetch would add header:', token ? 'YES' : 'NO');

// Test 3: Make test API call with Authorization header
console.log('\n3. Testing API call with Authorization header:');
const apiUrl = 'https://4aukdm2t58.execute-api.ca-central-1.amazonaws.com/whoami';
console.log('   Calling:', apiUrl);

try {
  const response = await testFetch(apiUrl);
  const data = await response.json();
  console.log('   Status:', response.status);
  console.log('   Response:', data);

  if (response.status === 200 && data.userId) {
    console.log('   ✅ SUCCESS! Token is valid and being used');
  } else if (response.status === 401) {
    console.log('   ❌ Still unauthorized - check if token is valid');
  }
} catch (error) {
  console.error('   Error:', error.message);
}

// Test 4: Show what SDK will do
console.log('\n4. What the SDK will do:');
console.log('   - SDK creates client with custom fetch function');
console.log('   - On every request, custom fetch adds Authorization header');
console.log('   - Header format: Bearer <token>');
console.log('   - Token source: localStorage.getItem("cognito_id_token")');
console.log('   - Result: All API requests should now be authenticated');
