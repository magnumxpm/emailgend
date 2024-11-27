const mongoose = require("mongoose");

const { Schema } = mongoose;

const personSchema = new Schema({
  id: String,
  name: String,
  photo_url: String,
  title: String,
  receiverLinkedInURL: String,
  receiverOrgWebsiteURL: String,
  emails: [
    {
      emailNumber: Number,
      emailContent: String,
      emailSubject: String,
    },
  ],
});

const generatedEmailBodySchema = new Schema({
  company_id: String,
  description: String,
  name: String,
  company_logo_url: String,
  people: [personSchema],
});

const generatedEmailMetadataSchema = new Schema({
  userId: String,
  campaignId: String,
  model: String,
  emailData: [generatedEmailBodySchema],
});

const generatedEmailSchema = new Schema({
  userId: { type: String, required: true },
  campaignId: { type: String, required: true },
  jobId: { type: String, required: true },
  isDone: { type: Boolean, default: false },
  emails: generatedEmailMetadataSchema,
});

const GeneratedEmail = mongoose.model("GeneratedEmail", generatedEmailSchema);

module.exports = {
  GeneratedEmail,
};
