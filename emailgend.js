const dotenv = require("dotenv");
const axios = require("axios");
const jobMQ = require("./lib/job_queue");
const { GeneratedEmail } = require("./models/email");
const OpenAI = require("openai");
const { z } = require("zod");
const { zodResponseFormat } = require("openai/helpers/zod");
const mongoose = require("mongoose");

console.log("Reading Configuration...");
dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const RAPID_API_KEY = process.env.RAPID_API_KEY;
const MODEL = process.env.MODEL || "gpt-4o-2024-08-06"; // Email generation model

if (!MONGO_URI || !OPENAI_API_KEY || !RAPID_API_KEY) {
  console.error(
    "emailgend :: ERR :: environment variables are not set. Aborting.",
  );
  process.exit(1);
}

// Connect to MongoDB
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const openai = new OpenAI();

const saveGeneratedEmails = async (jobID, emails, userId, campaignId) => {
  try {
    const existingDoc = await GeneratedEmail.findOne({ jobId: jobID });
    if (!existingDoc) {
      return false;
    }

    console.log("userID: ", userId, "campaignID: ", campaignId);

    existingDoc.emails = {
      userId,
      campaignId,
      model: MODEL,
      emailData: emails,
    };
    existingDoc.isDone = true;

    await existingDoc.save();
    return true;
  } catch (err) {
    console.error(
      "[emailgend] (saveGeneratedEmails) Error while saving the generated emails: ",
      err,
    );
    return false;
  }
};

// Schema for the summaries returned by GPT
const SummarySchema = z.object({
  websiteSummary: z.string(),
  linkedinSummary: z.string(),
});

const EmailGenerationReasoning = z.object({
  email_subject: z.string(),
  primary_email: z.string(),
  first_follow_up_email: z.string(),
  second_follow_up_email: z.string(),
});

// Function to generate the three emails for a given person
const processPersonEmails = async (
  person,
  user,
  ProductName,
  painPoints,
  valueProposition,
  callToAction,
  emailSignature,
  userSummary,
  orgSummary,
  personName,
  userName,
  personTitle,
  userDescription,
  motivationOfOutreach,
  emailTone,
  extraInformation,
  successStories,
) => {
  console.log("Processing person:", person.name);

  const promptBody = `You are an expert at writing professional cold emails that actually receive replies. My company/product name is ${ProductName} and we\'re solving the following pain points: ${painPoints}. Our value proposition is ${valueProposition}. The call-to-action of the email has to be: ${callToAction}. Add the following email signature at the bottom of the email: ${emailSignature}.
The name of the recipient of this email is ${personName || person.name}. The recipient currently works at ${userName || user.name} at a post of ${personTitle || person.title}. The description of the company the recipient works at is as follows: ${userDescription || user.description}. The summary of the recipient’s company is ${person.receiverOrgWebsiteSummary}. The summary of the recipient’s LinkedIn is ${person.receiverLinkedInSummary}. The sender’s company\'s website summary is as follows: ${orgSummary}. The sender’s linkedin profile\'s summary is as follows: ${userSummary}. Some extra information provided by the sender: ${extraInformation}. Some success stories of the sender’s company: ${successStories}. Motivation of outreach for the sender: ${motivationOfOutreach}. The tone of the email should be ${emailTone}. Write 3 cold emails(subject + text content + email signature), each of them under 200 words. The first email will be the original email that we’ll send. The second email that you write should be the first follow-up to the original email and the third email that you write should be the second(and the last) follow-up. All email bodies should use HTML formatting with <br/> tags rather than "\\n" for example. Write out the email_subject (same for all three), primary_email, first_follow_up_email, second_follow_up_email accordingly. Do not include the subject in primary_email, first_follow_up_email, and second_follow_up_email.`;

  const completion = await openai.beta.chat.completions.parse({
    model: MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are an expert at generating cold emails based on user input that actually work and are capable of getting a response.",
      },
      { role: "user", content: promptBody },
    ],
    response_format: zodResponseFormat(
      EmailGenerationReasoning,
      "email_generation_reasoning",
    ),
  });

  const email_generation_reasoning = completion.choices[0].message.parsed;
  const personEmails = [
    {
      emailNumber: 1,
      emailContent: email_generation_reasoning.primary_email,
      emailSubject: email_generation_reasoning.email_subject,
    },
    {
      emailNumber: 2,
      emailContent: email_generation_reasoning.first_follow_up_email,
      emailSubject: email_generation_reasoning.email_subject,
    },
    {
      emailNumber: 3,
      emailContent: email_generation_reasoning.second_follow_up_email,
      emailSubject: email_generation_reasoning.email_subject,
    },
  ];

  console.log("MODEL: ", MODEL, "personEmails: ", personEmails);
  return {
    ...person,
    emails: personEmails,
  };
};

const generateEmails = async (requestData) => {
  try {
    const {
      ProductName,
      painPoints,
      userId,
      campaignId,
      valueProposition,
      callToAction,
      emailSignature,
      userSummary,
      orgSummary,
      emailData,
      personName,
      userName,
      personTitle,
      userDescription,
      motivationOfOutreach,
      emailTone,
      extraInformation,
      successStories,
    } = requestData;

    const emails = [];

    // Process each company
    for (const user of emailData) {
      console.log(
        "[emailgend] (generateEmails) Processing company:",
        user.name,
      );

      // Process each person in parallel
      const processedPeople = await Promise.all(
        user.people.map(async (person) => {
          // Step 1: Fetch website & LinkedIn data in parallel
          const {
            id,
            receiverOrgWebsiteURL: website,
            receiverLinkedInURL: linkedin_url,
          } = person;

          let websiteContent = "";
          let linkedinData = null;

          const scrapeTasks = [];

          // Website scraping if available
          if (website) {
            const websitePromise = axios
              .post(
                "https://ai-content-scraper.p.rapidapi.com/scrape",
                { url: website },
                {
                  headers: {
                    "Content-Type": "application/json",
                    "x-rapidapi-host": "ai-content-scraper.p.rapidapi.com",
                    "x-rapidapi-key": RAPID_API_KEY,
                  },
                },
              )
              .then((resp) => resp.data.content)
              .catch((error) => {
                console.error(
                  `Error scraping website for id ${id}:`,
                  error.message,
                );
                return "";
              });
            scrapeTasks.push(
              websitePromise.then((content) => {
                websiteContent = content;
              }),
            );
          }

          // LinkedIn scraping if available
          if (linkedin_url) {
            const linkedinPromise = axios
              .get(
                `https://linkedin-data-api.p.rapidapi.com/get-profile-data-by-url?url=${linkedin_url}`,
                {
                  headers: {
                    "x-rapidapi-host": "linkedin-data-api.p.rapidapi.com",
                    "x-rapidapi-key": RAPID_API_KEY,
                  },
                },
              )
              .then((resp) => resp.data.response)
              .catch((error) => {
                console.error(
                  `Error scraping LinkedIn profile for id ${id}:`,
                  error.message,
                );
                return null;
              });
            scrapeTasks.push(
              linkedinPromise.then((data) => {
                linkedinData = data;
              }),
            );
          }

          await Promise.all(scrapeTasks);

          // Step 2: Use GPT to summarize website and LinkedIn data
          const messages = [
            {
              role: "system",
              content: `You are an assistant that summarizes website content and LinkedIn profiles. You will get a website content and a linkedin profile data. Your task is to summarize them effectively. You should answer with 'websiteSummary' and 'linkedinSummary'.`,
            },
            {
              role: "user",
              content: `${websiteContent ? `Website Content:\n${websiteContent}\n` : ""}${
                linkedinData
                  ? `LinkedIn Profile Data:\n${JSON.stringify(linkedinData)}\n`
                  : ""
              }`,
            },
          ];

          const completion = await openai.beta.chat.completions.parse({
            model: "gpt-4o",
            messages,
            response_format: zodResponseFormat(SummarySchema, "summary_schema"),
          });

          const summary_schema = completion.choices[0].message.parsed;
          person.receiverLinkedInSummary = summary_schema.linkedinSummary;
          person.receiverOrgWebsiteSummary = summary_schema.websiteSummary;

          // Step 3: Once we have the summaries, generate the emails for this person
          const processedPerson = await processPersonEmails(
            person,
            user,
            ProductName,
            painPoints,
            valueProposition,
            callToAction,
            emailSignature,
            userSummary,
            orgSummary,
            personName,
            userName,
            personTitle,
            userDescription,
            motivationOfOutreach,
            emailTone,
            extraInformation,
            successStories,
          );

          return processedPerson;
        }),
      );

      emails.push({
        company_id: user.company_Id || user.company_id,
        company_logo_url: user.company_logo_url || "",
        description: user.description || "",
        name: user.name || "",
        people: processedPeople,
      });
    }

    return emails;
  } catch (err) {
    console.error(
      "[emailgend] (generateEmails) Error while generating emails: ",
      err,
    );
    throw err;
  }
};

const listen = async () => {
  await jobMQ.ensure_queue("email_generation");
  console.warn(
    "emailgend will start listening for new jobs in queue<email_generation>",
  );
  console.info("Listening for incoming messages...");

  await jobMQ.subscribe("email_generation", async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.content.toString());
      console.info("Message received. JobID: ", data.jobID);
    } catch (err) {
      console.error("Failed to parse message content. Error: ", err);
      return;
    }

    try {
      const allEmails = await generateEmails(data.message);
      await saveGeneratedEmails(
        data.jobID,
        allEmails,
        data.message.userId,
        data.message.campaignId,
      );

      // Acknowledge the message
      jobMQ.config.channel.ack(msg);
      console.info("Generated and saved emails. JobID: ", data.jobID);
    } catch (err) {
      console.error("Failed to process jobID: ", data.jobID, "Error:", err);
      return;
    }
  });
};

// Initialize AMQP connection
jobMQ
  .init()
  .then(() => {
    console.log("AMQP connection established.");
    listen();
  })
  .catch((err) => {
    console.error("Failed to establish AMQP connection:", err);
    process.exit(1);
  });
