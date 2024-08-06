/**
 * node contact upload command line tool.
 * 
 * Takes command line arguments for the name of the search to add profiles to
 * and the path to the csv with linkedin profiles. CSV must have a "LinkedIn URL" column
 * and no filled rows before the header row. 2FA must be authorized every run for LinkedIn,
 * terminal awaits manual input after 2FA before proceeding. 
 * 
 * In case of potential duplicates, these profiles are not added/updated but reported
 * for manual review.
 */

const { chromium } = require("playwright");
const fs = require('fs');
const csv = require('csv-parser');
const {THRIVE_EMAIL, THRIVE_PASSWORD, LI_EMAIL, LI_PASSWORD} = require('./secret');
const THRIVE_LOGIN_URL = "https://searchessentials.thrivetrm.com/users/sign_in";
const LI_LOGIN_URL = "https://www.linkedin.com/login";
const THRIVE_CONTACTS_URL = "https://searchessentials.thrivetrm.com/contacts/";

//extract cmnd line arguments (ONLY WORKS FOR RYAN FOR DEV, RM STRING LITERAL FOR PROD)
const searchName = process.argv[2];
const csvPath = `/Users/ryanchitwood/Downloads/${process.argv[3]}`;

const duplicates = [];

if (searchName === '--help'){
    console.log("Script will iterate through CSV, uploading profiles to designated search (likely path: /users/username/Downloads/csvName.csv). Usage: node uploadProfiles.js searchName path/to/csv");
    process.exit(0);
}

if (!searchName || !csvPath) {
    console.error('Error: missing arguments. Usage: node uploadProfiles.js searchName path/to/csv');
    process.exit(1);
  }

/** login to thrive on login page */
async function loginToThrive(page){
    await page.waitForSelector('#user_email');
    await page.waitForSelector('#user_password');
    await page.fill('#user_email', THRIVE_EMAIL);
    await page.fill('#user_password', THRIVE_PASSWORD);
    await page.click('input[type="submit"][value="Log in"]');
}

/** login to LinkedIn on login page */
async function loginToLinkedIn(page){
    await page.waitForSelector('#username');
    await page.waitForSelector('#password');
    await page.fill('#username', LI_EMAIL);
    await page.fill('#password', LI_PASSWORD);
    // BUG: Sign in with apple ID not ignored
    await page.click('button:has-text("Sign in")');
}

/** awaits for manual 2FA before proceeding with script */
async function waitForManual2FA() {
    console.log('Please complete the 2FA process in the browser window.');
    console.log('Press Enter to continue after completing 2FA.');
    await new Promise(resolve => process.stdin.once('data', resolve));
}

/** iterate through csv and return array of LI profiles to visit */
function parseCsv(path){
    return new Promise((resolve, reject) => {
        const urlColumn = [];
        fs.createReadStream(path)
            .pipe(csv())
            .on('data', (row) => {
                const url = row['LinkedIn URL'];
                if (url) {
                urlColumn.push(url);
                }
            })
            .on('end', () => {
                resolve(urlColumn);
            })
            .on('error', (err) => {
                console.error("error reading file", err);
                reject(err);
            });
    });
}

/** hellper function to format first and last name from full name and returns as array [firstName, lastName] */
function formatName(fullName) {

    // removes common prefixes and suffixes
    const prefixesToOmit = ['Dr. ', 'Dr '];
    const suffixesToOmit = [' CPA', ', CPA', ', Esq.', ' Esq.', ', MBA', ' MBA', ', M.D.', ' M.D.', ' PhD', ' Ph.D', ', PhD', ', Ph.D'];
    for (const prefix of prefixesToOmit) {
        if (fullName.startsWith(prefix)) {
            fullName = fullName.slice(prefix.length);
            break;
        }
    }
    for (const suffix of suffixesToOmit) {
        if (fullName.endsWith(suffix)) {
            fullName = fullName.slice(0, -suffix.length);
        }
    }
    const splitName = fullName.split(" ");

    // normal firstName lastName, return
    if (splitName.length === 2) return [splitName[0], splitName[1]];

    // treat middle initials or additional names as first name
    if (splitName.length > 2) return [splitName.slice(0, splitName.length - 1).join(' '), splitName[splitName.length - 1]];
}

/** helper function to format location as array [city, state, country] */
function formatLocation(locationStr) {
    const splitLocation = locationStr.split(", ");
    // handle metro city areas, profiles that only have country and non-US locations (no state)
    // if it includes "area", it is a metro area (city) and can be handled normally, otherwise it is country
    if (splitLocation.length === 1 && !splitLocation[0].includes("Area")){
        return [undefined, undefined, splitLocation[0]];
    } else if (splitLocation.length === 2) {
        return [splitLocation[0], undefined, splitLocation[1]];
    }
    return splitLocation;
}

/** helper function to take array of unlabeled anchor links and return as object { email, URL }*/
function parseContactData(anchorLinks){
    const contact = {};
    for (link of anchorLinks) {
        if (link.includes("linkedin")){
            contact.URL = link;
        } else if (link.includes("@")){
            contact.email = link.replace("mailto:", "");
        }
    }
    return contact;
}

/** helper functin to format tenure dates and return as [startDate, endDate] */
function formatTenure(tenureString) {
    const tenureArray = tenureString.split(" - ");
    tenureArray[1] = removeDots(tenureArray[1]);
    if (tenureArray[1] === "Present") tenureArray[1] = null;
    return tenureArray;
}

/** helper function to format dates and return as [startDate, endDate] and remove months if present */
function formatDateYear(dateString) {
    // remove dash and dots if present and convert to array
    const formattedDates = [];
    const dates = formatTenure(dateString);
    for (let date of dates) {
        // remove month if present. Will always be YYYY or MMM YYYY
        if (date.length === 8) {
            formattedDates.push(date.slice(4));
        } else {
            formattedDates.push(date);
        }
    }
    return formattedDates;
}

/** helper function to extract the dot from company strings */
function removeDots(input) {
    const separatorIndex = input.indexOf(' · ');
    if (separatorIndex !== -1) {
      return input.substring(0, separatorIndex);
    }
    return input;
  }

/** extract profile data from LinkedIn profile and returns object
 * 
 * {firstName: "", 
 *  lastName: "", 
 *  location: {city: "", state: "", country: ""}, 
 *  contact: {email: "", URL: ""}, 
 *  experience: [{title: "", company: "", startDate: "", endDate: "", description: ""}, {...}, ...],
 *  education: [{schoolName: "", degree: "", startYear: "", endYear: "", description: ""}, {...}, ...]
 * }
 */
async function extractProfileData(profileUrl, page){
    await page.goto(profileUrl);
    const profile = {
        location: {},
        contact: {},
        experience: [],
        education: []
    };

    // extract, format and save name to profile
    const nameElement = await page.waitForSelector(".artdeco-hoverable-trigger.artdeco-hoverable-trigger--content-placed-bottom.artdeco-hoverable-trigger--is-hoverable.ember-view");
    const fullName = await page.evaluate(el => el.textContent, nameElement);
    const [firstName, lastName] = formatName(fullName.trim());
    profile.firstName = firstName;
    profile.lastName = lastName;
    
    // extract, format and save location to profile ** change .evaluate to simple .textContent?
    const locationElement = await page.waitForSelector(".text-body-small.inline.t-black--light.break-words");
    const locationStr = await page.evaluate(el => el.textContent, locationElement);
    const [city, state, country] = formatLocation(locationStr.trim());
    profile.location.city = city;
    profile.location.state = state;
    profile.location.country = country;

    //extract, format and save contact info to profile
    await page.click("#top-card-text-details-contact-info");
    await page.waitForSelector(".pv-profile-section__section-info.section-info");
    const contactAnchors = await page.$$(".pv-profile-section__section-info.section-info a");
    const anchorLinks = await page.evaluate(anchors => {
        return Array.from(anchors).map(anchor => anchor.href);
    }, contactAnchors);
    const parsedContact = parseContactData(anchorLinks);
    profile.contact = parsedContact;

    //extract, format, and save experience to profile
    await page.waitForSelector('svg use[href="#close-medium"]');
    await page.click('svg use[href="#close-medium"]');
    const experienceSection = await page.waitForSelector('section:has(div#experience)');

    // select and iterate through each company Li section
    const companyExperienceLis = await experienceSection.$$('li.artdeco-list__item');

    for (let cxl of companyExperienceLis) {
        const roleLis = await cxl.$$('div.pvs-entity__sub-components li div.display-flex.flex-column.full-width.align-self-center');
        // if multiple roles/company, must extract each role
        if (roleLis.length > 1) {
            const companySpan = await cxl.$('a[data-field="experience_company_logo"] span');
            const companyName = removeDots(await companySpan.textContent());
            for (let rl of roleLis) {
                const role = {};
                const textSpans = await rl.$$('span[aria-hidden="true"]');
                // accomodate for job location
                if (textSpans.length === 4) {
                    // location for role
                    role.title = await textSpans[0].textContent();
                    if (textSpans[3]) role.description = await textSpans[3].textContent();
                    role.company = companyName;
                    const [startDate, endDate] = formatTenure(await textSpans[1].textContent());
                    role.startDate = startDate;
                    role.endDate = endDate;
                } else {
                    // no location for role
                    role.title = await textSpans[0].textContent();
                    if (textSpans[2]) role.description = await textSpans[2].textContent();
                    role.company = companyName;
                    const [startDate, endDate] = formatTenure(await textSpans[1].textContent());
                    role.startDate = startDate;
                    role.endDate = endDate;
                }
                profile.experience.push(role);
            }
        } else {
            // only one role/company
            const role = {};
            const textSpans = await cxl.$$('span[aria-hidden="true"]');
            if (textSpans.length === 5) {
                //location for role
                role.title = await textSpans[0].textContent();
                if (textSpans[4]) role.description = await textSpans[4].textContent();;
                role.company = removeDots(await textSpans[1].textContent());
                const [startDate, endDate] = formatTenure(await textSpans[2].textContent());
                role.startDate = startDate;
                role.endDate = endDate;
            } else {
                // no location for role:
                role.title = await textSpans[0].textContent();
                if (textSpans[3]) role.description = await textSpans[3].textContent();;
                role.company = removeDots(await textSpans[1].textContent());
                const [startDate, endDate] = formatTenure(await textSpans[2].textContent());
                role.startDate = startDate;
                role.endDate = endDate;
            }
            profile.experience.push(role);
        }
    }
    //extract, format, and save education to profile
    const educationSection = await page.waitForSelector('section:has(div#education)');
    // break down each education record by Li
    const educationLis = await educationSection.$$('li.artdeco-list__item');
    for (let li of educationLis) {
        const educationRecord = {};
        //select text
        const textSpans = await li.$$('span[aria-hidden="true"]');
        // schoolName required by LinkedIn, rest optional. extract and save
        educationRecord.schoolName = await textSpans[0].textContent();
        if (textSpans[1]) educationRecord.degree = await textSpans[1].textContent();
        if (textSpans[2]) {
            const [startYear, endYear] = formatDateYear(await textSpans[2].textContent());
            educationRecord.startYear = startYear;
            educationRecord.endYear = endYear;
        }
        if (textSpans[3]) educationRecord.description = await textSpans[3].textContent();
        profile.education.push(educationRecord);
    }

    console.log(profile);
}

/** save all data in profile object to Thrive and add to designated search */
async function saveProfileToThrive(page, profile) {
    // fill add contact form with profile info
    await page.goto(THRIVE_CONTACTS_URL);
    const addContactButton = await page.waitForSelector("button[data-test-id='Add Contact button']");
    await page.waitForSelector("input[name='first_name']");
    await page.fill("input[name='first_name']", profile.firstName);
    await page.fill("input[name='last_name']", profile.lastName);
    await page.fill("input[name='email']", profile.contact.email);

    // if potential duplicate, report name for review and return
    // check by giving page 2s to report dupe

    // commented out code below likely too fast for DB to report dupe
    // const dupeDiv = await page.$("div.contact-duplicates");
    // const dupeWarning = await dupeDiv.textContent();
    // if (dupeWarning) {
    //     duplicates.push(profile.firstName.concat(" ", profile.lastName));
    //     return;
    // }
    try{
        await page.waitForFunction(
            (selector) => {
                const element = document.querySelector(selector);
                return element && element.textContent.trim() !== '';
            },
            { timeout: 2000 },
            "div.contact-duplicates"
        );
        duplicates.push(profile.firstName.concat(" ", profile.lastName));
        return;
    }catch{
        // dupe message never reported, continue
    }
    // TODO: continue w/ upload

}

/** upload profiles from csv to a user-specified Thrive search */
async function uploadProfiles(){
      // open new browser window
      const browser = await chromium.launch({ headless: false});
      const context = await browser.newContext();
      const page = await context.newPage();

      // navigate to login pages for browser auth cookies - LI has 2FA (still worth automation, can later tackle w/ browser context)
      await page.goto(THRIVE_LOGIN_URL);
      await loginToThrive(page);
      await page.goto(LI_LOGIN_URL);
      await loginToLinkedIn(page);

      // Wait for manual 2FA completion
      await waitForManual2FA();
      
      // parse profile links from csv
      const profileUrls = await parseCsv(csvPath);
      
      // hard coded 1 profile for testing
      for (let profile of profileUrls) {
        const data = await extractProfileData(profile, page);
      }
      //const data = await extractProfileData(profileUrls[0], page);
      
      // TODO:
      // iterate through profiles
      //   visit page
      //   extract data
      //   visit Thrive contact page, click new contact
      //   begin inserting data, start w fname lname, add contact (check for dupe)
      //   insert rest of data
    //   for (let profileUrl of profileUrls) {
    //     //const data = extractData(profileUrl)
    //     //saveDataToThrive(data)
    //   }
    await browser.close();
    if (duplicates.length) console.log("Potential duplicates not uploaded: ", duplicates);
    process.exit(0);
}



// define and call simple async function to call uploadProfiles
(async () => {
    await uploadProfiles();
})();

/** possible improvements:
 * click to more education/experience if more
 * validate duplicates with LinkedIn URL and update as needed
 * more error handling (try/catch) with reporting for debugging
 * move helper functions to new file
 * break down extractProfileData into more functions
 * TESTING
 */