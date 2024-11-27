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

// mongo controllers
const saveGeneratedEmails = async (jobID, emails, userId, campaignId) => {
  try {
    // get the existing
    const existingDoc = await GeneratedEmail.findOne({
      jobId: jobID,
    });
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

    // save it
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

// ---------------------------- AI Handlers ----------------------------

const fetchLinkedinAndWebsiteSummariesOfPeople = async (people) => {
  return await Promise.all(
    people.map(async (person) => {
      const { id, website, linkedin_url } = person;

      // Variables to hold scraped content
      let websiteContent = "";
      let linkedinData = "";

      // Array to hold scraping promises
      const scrapeTasks = [];

      // Scrape website content if URL is provided
      if (website) {
        const websiteContentPromise = axios
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
          .then((response) => {
            return response.data.content;
          })
          .catch((error) => {
            console.error(
              `Error scraping website for id ${id}:`,
              error.message,
            );
            return null;
          });

        scrapeTasks.push(
          websiteContentPromise.then((content) => {
            websiteContent = content;
          }),
        );
      }

      // Scrape LinkedIn profile data if URL is provided
      if (linkedin_url) {
        const linkedinDataPromise = axios
          .get(
            `https://linkedin-data-api.p.rapidapi.com/get-profile-data-by-url?url=${linkedin_url}`,
            {
              headers: {
                "x-rapidapi-host": "linkedin-data-api.p.rapidapi.com",
                "x-rapidapi-key": RAPID_API_KEY,
              },
            },
          )
          .then((response) => {
            return response.data.response;
          })
          .catch((error) => {
            console.error(
              `Error scraping LinkedIn profile for id ${id}:`,
              error.message,
            );
            return null;
          });

        scrapeTasks.push(
          linkedinDataPromise.then((data) => {
            linkedinData = data;
          }),
        );
      }

      // Wait for all scraping tasks to complete
      await Promise.all(scrapeTasks);

      // Define the schema for OpenAI's structured output
      const SummarySchema = z.object({
        websiteSummary: z.string(),
        linkedinSummary: z.string(),
      });

      // Prepare the prompt for OpenAI
      const messages = [
        {
          role: "system",
          content: `You are an assistant that summarizes website content and LinkedIn profiles. You will get a website content and a linkedin profile data. Your task will be to summarize them effectively, by talking about the subject (person) based on the information. You should answer with a 'websiteSummary' and a 'linkedinSummary'`,
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

      // Use OpenAI to get the summaries
      const completion = await openai.beta.chat.completions.parse({
        model: "gpt-4o",
        messages,
        response_format: zodResponseFormat(SummarySchema, "summary_schema"),
      });

      const summary_schema = completion.choices[0].message.parsed;
      console.log("Summary generated for id:", id);

      return {
        id,
        websiteSummary: summary_schema.websiteSummary,
        linkedinSummary: summary_schema.linkedinSummary,
      };
    }),
  );
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

    // Initialize emails array to store all company entries
    const emails = [];

    const processPersonEmails = async (person, user) => {
      console.log("Processing person:", person.name);

      const EmailGenerationReasoning = z.object({
        email_subject: z.string(),
        primary_email: z.string(),
        first_follow_up_email: z.string(),
        second_follow_up_email: z.string(),
      });

      // recipient company description -> userDescription || user.description
      // recipient's company summary -> personOrgWebsiteSummary
      // recipient's company website summary -> personOrgWebsiteSummary
      //

      const promptBody = `You are an expert at writing professional cold emails that actually receive replies. My company/product name is ${ProductName} and we\'re solving the following pain points: ${painPoints}. Our value proposition is ${valueProposition}. The call-to-action of the email has to be: ${callToAction}. Add the following email signature at the bottom of the email: ${emailSignature}.\n The name of the recipient of this email is ${personName || person.name}. The recipient currently works at ${userName || user.name} at a post of ${personTitle || person.title}. The description of the company the recipient works at is as follows: ${userDescription || user.description}. The summary of the recipient’s company is ${person.receiverOrgWebsiteSummary}. The summary of the recipient’s LinkedIn is ${person.receiverLinkedInSummary}. The sender\’s company\'s website summary is as follows: ${orgSummary}. The sender\’s linkedin profile\'s summary is as follows: ${userSummary}. Some extra information provided by the sender: ${extraInformation}. Some success stories of the sender’s company: ${successStories}. Motivation of outreach for the sender: ${motivationOfOutreach}. The tone of the email should be ${emailTone}. Write 3 cold email(subject + text content + email signature), each of them under 200 words. The first email will be the original email that we’ll send. The second email that you write should be the first follow-up to the original email and the third email that you write should be the second(and the last) follow-up to the original, and the first follow-up emails. Write out the email_subject (same for all three), primary_email, first_follow_up_email, second_follow_up_email accordingly. Do not include the subject in primary_email, first_follow_up_email, and second_follow_up_email.`;

      const completion = await openai.beta.chat.completions.parse({
        model: MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are an expert at generating cold emails based on user input that actually work and are capable of getting a response from the other end.",
          },
          { role: "user", content: promptBody },
        ],
        response_format: zodResponseFormat(
          EmailGenerationReasoning,
          "email_generation_reasoning",
        ),
      });

      // TODO: Should the AI fail to generate content, there should be an error parameter to
      // pass on the error message to the frontend.

      // if (!completion.choices[0].message.success) {
      // 	console.error(
      // 		'Failed to parse generated emails:',
      // 		parsedEmails.error
      // 	);
      // 	throw new Error('Invalid email format generated by AI');
      // }

      const email_generation_reasoning = completion.choices[0].message.parsed;

      const personEmails = [];
      personEmails.push({
        emailNumber: 1,
        emailContent: email_generation_reasoning.primary_email,
        emailSubject: email_generation_reasoning.email_subject,
      });
      personEmails.push({
        emailNumber: 2,
        emailContent: email_generation_reasoning.first_follow_up_email,
        emailSubject: email_generation_reasoning.email_subject,
      });
      personEmails.push({
        emailNumber: 3,
        emailContent: email_generation_reasoning.second_follow_up_email,
        emailSubject: email_generation_reasoning.email_subject,
      });

      console.log("MODEL: ", MODEL, "personEmails: ", personEmails);

      return {
        ...person,
        emails: personEmails,
      };
    };

    // Process all companies and their people
    for (const user of emailData) {
      console.log(
        "[emailgend] (generateEmails) Processing company:",
        user.name,
      );

      // aggregate all the person URLs
      const personURLs = user.people.map((person) => {
        return {
          id: person.id,
          website: person.receiverOrgWebsiteURL,
          linkedin_url: person.receiverLinkedInURL,
        };
      });

      const summaries =
        await fetchLinkedinAndWebsiteSummariesOfPeople(personURLs);

      // convert summaries to a Map() to avoid failures
      const SummaryMap = new Map();
      for (const ps of summaries) {
        SummaryMap.set(ps.id, ps);
      }

      // Process all people in the company
      const peoplePromises = user.people.map(async (person) => {
        // Iteratively add the corresponding summary inside the person object

        const summary = SummaryMap.get(person.id);
        person.receiverLinkedInSummary = summary ? summary.linkedinSummary : "";
        person.receiverOrgWebsiteSummary = summary
          ? summary.websiteSummary
          : "";

        // pass the populated person to process the emails
        const processedPerson = await processPersonEmails(person, user);
        return processedPerson;
      });

      const processedPeople = await Promise.all(peoplePromises);

      // Add the company with processed people to emails array
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
      "[emailgend] (saveGeneratedEmails) Error while generating emails: ",
      err,
    );
    throw err;
  }
};

// ---------------------------- MQ Listener ----------------------------

const listen = async () => {
  await jobMQ.ensure_queue("email_generation");

  console.warn(
    "emailgend will start listening for new jobs in queue<email_generation>",
  );
  console.info("Listening for incomming messages...");

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
      // generate all the emails, without pagination
      const allEmails = await generateEmails(data.message);

      // save all the emails
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
    process.exit(1); // Exit the process if connection fails
  });
