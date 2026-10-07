const axios = require('axios');
const logger = require('../utils/logger');

class DevelopmentProvider {
  async sendOtp(phone, otp) {
    if (process.env.NODE_ENV !== 'production') {
      logger.info(`[DEV-SMS-PROVIDER] Simulated OTP send to ${phone}: ${otp}`);
    }
    return { success: true, provider: 'development' };
  } 
}

class TwilioProvider {
  constructor() {
    this.accountSid = process.env.OTP_API_KEY;
    this.authToken = process.env.OTP_API_SECRET;
    this.fromNumber = process.env.OTP_SENDER_ID;
  }

  async sendOtp(phone, otp) {
    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new Error('Twilio credentials missing in environment');
    }
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const params = new URLSearchParams({
      To: phone,
      From: this.fromNumber,
      Body: `Your SwachhaNet verification code is ${otp}. Valid for 10 minutes.`,
    });

    const res = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      params.toString(),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );
    return { success: true, provider: 'twilio', messageId: res.data.sid };
  }
}

class Fast2SMSProvider {
  constructor() {
    this.apiKey = process.env.OTP_API_KEY;
    this.senderId = process.env.OTP_SENDER_ID;
    this.templateId = process.env.OTP_TEMPLATE_ID;
  }

  async sendOtp(phone, otp) {
    if (!this.apiKey) {
      throw new Error('Fast2SMS API key missing in environment');
    }
    // Extract 10-digit number for Fast2SMS
    const digits = phone.replace(/\D/g, '').slice(-10);
    const res = await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      {
        variables_values: otp,
        route: 'otp',
        numbers: digits,
      },
      {
        headers: {
          authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    return { success: res.data.return, provider: 'fast2sms' };
  }
}

class OTPService {
  constructor() {
    this.providers = {
      development: new DevelopmentProvider(),
      twilio: new TwilioProvider(),
      fast2sms: new Fast2SMSProvider(),
    };
  }

  getProvider() {
    const providerName = (process.env.OTP_PROVIDER || 'development').toLowerCase();
    return this.providers[providerName] || this.providers.development;
  }

  async sendOTP(phone, otp) {
    try {
      const provider = this.getProvider();
      logger.info(`Sending OTP to normalized phone number via provider: ${process.env.OTP_PROVIDER || 'development'}`);
      return await provider.sendOtp(phone, otp);
    } catch (err) {
      logger.error(`Failed to dispatch SMS via OTP provider: ${err.message}`);
      if (process.env.NODE_ENV !== 'production') {
        // In development, a separate log from DevelopmentProvider.sendOtp already shows the OTP.
        // This catch handles unexpected errors and must NOT log the OTP value in any env.
        logger.warn(`OTP send failed for provider: ${process.env.OTP_PROVIDER || 'development'}`);
      }
      return { success: false, error: err.message };
    }
  }
}

module.exports = new OTPService();