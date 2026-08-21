import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  
  // Optional: Define static, overarching groups if you need a master admin tier
  // that can oversee all associations. Tenant-specific groups (ASSOC#101) 
  // will be created dynamically via the AWS SDK or CLI when a new tenant onboards.
  groups: ["SuperAdmin"],

  userAttributes: {
    // Collect the admin's name during sign-up
    fullname: {
      required: true,
      mutable: true,
    },
    // Optional phone number for the admin
    phoneNumber: {
      required: false,
      mutable: true,
    },
  },
});