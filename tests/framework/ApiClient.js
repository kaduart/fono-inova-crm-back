// tests/framework/ApiClient.js
// Cliente HTTP com autenticação automática para testes

import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:5000';

class ApiClient {
  constructor() {
    this.baseURL = API_URL;
    // Usa o mesmo token do .env ou permite override via env
    this.token = process.env.TEST_API_TOKEN || 'placeholder-token';
  }
  
  getHeaders() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };
  }
  
  async patch(endpoint, data = {}, options = {}) {
    return axios.patch(
      `${this.baseURL}${endpoint}`,
      data,
      {
        ...options,
        headers: {
          ...this.getHeaders(),
          ...options.headers
        }
      }
    );
  }
  
  async post(endpoint, data = {}, options = {}) {
    return axios.post(
      `${this.baseURL}${endpoint}`,
      data,
      {
        ...options,
        headers: {
          ...this.getHeaders(),
          ...options.headers
        }
      }
    );
  }
  
  async get(endpoint, options = {}) {
    return axios.get(
      `${this.baseURL}${endpoint}`,
      {
        ...options,
        headers: {
          ...this.getHeaders(),
          ...options.headers
        }
      }
    );
  }
}

export default new ApiClient();
