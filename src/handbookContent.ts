/**
 * Employee Manual — phone-first structured content.
 * Source: Total Assurance Employee Manual 2026 (migrated from PDF for digital reading).
 * Policy meaning preserved; formatting adapted for phones. Not an employment contract.
 */

export type HandbookTopic = {
  id: string;
  sectionId: string;
  title: string;
  summary: string;
  keywords?: string[];
  body: string[];
};

export type HandbookSection = {
  id: string;
  title: string;
  summary: string;
  topicIds: string[];
};

export type HandbookQuickAnswer = {
  label: string;
  topicId: string;
};

export const HANDBOOK_META = {
  title: "Employee Manual",
  versionLabel: "2026",
  effectiveDate: "2026-01-01",
  company: "Total Assurance A/C & Heating",
  address: "3833 Saturn Rd, Corpus Christi, Texas 78413",
  phone: "361-446-6925",
  license: "TACLA47840E",
} as const;

export const HANDBOOK_QUICK_ANSWERS: HandbookQuickAnswer[] = [
  { label: "Sick days", topicId: "6.2" },
  { label: "Vacation / PTO", topicId: "6.3" },
  { label: "Overtime", topicId: "3.2" },
  { label: "Company vehicles", topicId: "4.10" },
  { label: "Cell phones", topicId: "4.9" },
  { label: "Harassment", topicId: "4.1" },
  { label: "Attendance", topicId: "4.2" },
  { label: "At-will employment", topicId: "1.4" },
];

export const HANDBOOK_SECTIONS: HandbookSection[] = [
  {
    id: "1",
    title: "Introduction",
    summary: "Welcome, how this manual works, and at-will employment.",
    topicIds: ["1.1", "1.2", "1.3", "1.4"],
  },
  {
    id: "2",
    title: "Employment Policies",
    summary: "Classifications, EEO, confidentiality, relatives, and workplace rules.",
    topicIds: ["2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.9", "2.10", "2.11", "2.12"],
  },
  {
    id: "3",
    title: "Hours & Payroll",
    summary: "Paydays, overtime, breaks, time cards, and deductions.",
    topicIds: ["3.1", "3.2", "3.3", "3.4", "3.5", "3.6", "3.7"],
  },
  {
    id: "4",
    title: "Conduct & Performance",
    summary: "Harassment, attendance, safety, phones, vehicles, and workplace standards.",
    topicIds: ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "4.8", "4.9", "4.10", "4.11"],
  },
  {
    id: "5",
    title: "Benefits",
    summary: "Insurance, workers’ compensation, and other company benefits.",
    topicIds: ["5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8"],
  },
  {
    id: "6",
    title: "Leaves & Time Off",
    summary: "Sick, vacation, holidays, FMLA, bereavement, jury duty, and voting.",
    topicIds: ["6.1", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "6.8", "6.9"],
  },
];

export const HANDBOOK_TOPICS: HandbookTopic[] = [
  {
    id: "1.1",
    sectionId: "1",
    title: "Welcome to Total Assurance A/C & Heating",
    summary: "A welcome to the team and what this manual is for.",
    body: [
      "It is with great pleasure that we extend a warm welcome to you! We are thrilled to have you join our team and look forward to the contributions and fresh perspectives you will bring to our dynamic workplace. This comprehensive Employee Manual has been prepared to help you seamlessly integrate into our work environment and understand our shared values, expectations, and resources. In this manual you will find insights into our mission of delivering exceptional heating, ventilation, and air conditioning services with integrity and excellence. We are committed to fostering a collaborative, inclusive, and safe workplace where every team member can thrive and grow professionally. This Manual outlines your rights and responsibilities, details employee benefits and support systems, and provides guidance to ensure your success. We encourage you to review it thoroughly at your earliest convenience. Welcome aboard—we are excited to embark on this journey together and are confident that your contributions will play an integral role in our continued success.",
    ],
  },
  {
    id: "1.2",
    sectionId: "1",
    title: "About This Employee Manual",
    summary: "What the manual covers — and that it is not an employment contract.",
    body: [
      "This Employee Manual (the “Manual”) summarizes certain personnel policies, procedures, and benefits of Total Assurance A/C & Heating (the “Company”), located at 3833 Saturn Rd, Corpus Christi, Texas 78413. It is designed to acquaint all employees with the rules and expectations concerning employment with the Company. Compliance with the Company’s policies is a condition of employment. This Manual supersedes all previous employment policies, whether written or oral, express or implied. The Company reserves the right to modify, rescind, delete, or add to the provisions of this Manual at any time in its sole and absolute discretion. This Manual is not a binding contract between the Company and its employees, nor is it intended to alter the at-will employment relationship. The Company reserves the right to interpret the policies herein and to deviate from them when, in its discretion, it determines it is appropriate. To ensure understanding, employees must confirm you have read this manual in the Field App (and again when updates are issued). Failure to comply with the policies in this Manual may result in disciplinary action, up to and including termination of employment.",
    ],
  },
  {
    id: "1.3",
    sectionId: "1",
    title: "Changes in Policy & Annual Review",
    summary: "How policies can change and how updates are communicated.",
    body: [
      "Because our business is constantly evolving, the Company expressly reserves the right to revise, modify, delete, or add to any and all policies, procedures, work rules, or benefits stated in this Manual or in any other document, except for the policy of at-will employment. No oral statements or representations can alter the provisions of this Manual. Nothing in this Manual or in any other document, including benefit plan descriptions, creates or is intended to create a promise or representation of continued employment for any employee. Any changes to your at-will employment status must be in writing and signed by an authorized officer of the Company (CEO, President, or CFO). Policy reviews occur at least annually during the first quarter. Changes are communicated via email or posted notices with at least 30 days’ advance notice, unless required sooner by law or urgent circumstances. Employees must acknowledge receipt of any updates within seven (7) days in the Field App. If you are uncertain about any policy or procedure, contact your manager or Human Resources immediately. Failure to acknowledge updates may result in counseling or disciplinary action.",
    ],
  },
  {
    id: "1.4",
    sectionId: "1",
    title: "Employment-At-Will",
    summary: "Employment is at-will unless a written agreement says otherwise.",
    keywords: ["at-will", "resign", "terminate", "fired"],
    body: [
      "Employment with the Company is on an at-will basis, unless otherwise specified in a written employment agreement signed by an authorized officer. You are free to resign at any time, for any reason, with or without notice. Similarly, the Company is free to conclude the employment relationship at any time for any lawful reason, with or without cause, and with or without notice. Nothing in this Manual limits the right of either party to terminate the at-will employment relationship. No section of this Manual is meant to be construed as establishing anything other than an at-will employment relationship. This Manual does not limit management’s discretion to make personnel decisions such as reassignment, changes in wages and benefits, demotion, or other actions. No person other than the CEO, President, or CFO has the authority to enter into an agreement for employment for any specified period of time or to make an agreement for employment other than on at-will terms. Any such agreement is binding only if it is in writing and signed by the President. Examples of at-will application include immediate termination for serious misconduct or performance-based decisions without prior warnings.",
    ],
  },
  {
    id: "2.1",
    sectionId: "2",
    title: "Employee Classifications",
    summary: "Exempt, nonexempt, full-time, part-time, temporary, and contractors.",
    body: [
      "The following terms are used to describe employees and their employment status to ensure fair application of wages, benefits, and overtime rules:",
      "a. Exempt Employees — Employees whose positions meet specific tests established by the Fair Labor Standards Act (“FLSA”) and Texas state law. In general, exempt employees are those engaged in executive, managerial, high-level administrative, and professional jobs who are paid a fixed salary (at least $58,656 annually as of 2025, subject to future adjustments) and perform certain duties. Certain commissioned sales employees and highly paid computer professionals may also qualify as exempt. Exempt employees are not subject to minimum wage and overtime laws. Classification is determined at hire based on job duties and salary. Any disputes must be raised with Human Resources within 30 days for review.",
      "b. Nonexempt Employees — Employees whose positions do not meet FLSA and Texas state law tests. All employees covered by federal or state minimum wage and overtime laws are considered nonexempt. Employees in nonexempt jobs are entitled to be paid at least the federal minimum wage per hour ($7.25 as of 2026) and a premium for overtime hours worked.",
      "c. Full-Time Employees — Employees who are not temporary employees, independent contractors, or independent consultants and who are regularly scheduled to work 35 or more hours per workweek. Eligible for full benefits after successful completion of the introductory period.",
      "d. Part-Time Employees — Employees who are not temporary employees, independent contractors, or independent consultants and who are regularly scheduled to work fewer than 35 hours per workweek. Benefits, if any, are prorated based on hours worked.",
      "e. Temporary Employees — Employees hired as interim replacements to temporarily supplement the workforce or to assist in the completion of a specific project. Employment assignments in this category are of limited duration, and the temporary employee may be released before the end of the defined period. Short-term assignments are generally periods of three months or less; however, such assignments may be extended. All temporary employees are at-will regardless of the anticipated duration of the assignment. Temporary employees retain that status unless and until notified in writing of a change. No benefits eligibility.",
      "f. Independent Contractor or Consultant — These individuals are not employees of the Company and are self-employed. An independent contractor or consultant is engaged to perform a task according to their own methods and is subject to control and direction only as to the results to be accomplished. Independent contractors or consultants are not entitled to employee benefits. Each employee will be advised of their classification at the time of hire and upon any change in status. Regardless of classification, every employee is employed at-will, and the employment relationship may be terminated by the Company or the employee at any time, with or without cause and with or without notice. Reports of misclassification will be investigated confidentially and without retaliation.",
    ],
  },
  {
    id: "2.2",
    sectionId: "2",
    title: "Equal Employment Opportunity, ADA, CROWN Act & AI Bias Prevention",
    summary: "Equal opportunity, ADA, CROWN Act, pregnancy accommodations, and AI bias rules.",
    keywords: ["eeo", "discrimination", "ada", "crown", "pregnancy", "ai"],
    body: [
      "It is the policy of the Company to provide equal employment opportunities to all employees and employment applicants without regard to unlawful considerations of race, religion, creed, color, national origin, sex, pregnancy, sexual orientation, gender identity, age, ancestry, physical or mental disability, genetic information, marital status, veteran status, or any other classification protected by applicable local, state, or federal laws. This policy expressly incorporates the Texas CROWN Act, which prohibits discrimination based on hair texture or protective hairstyles (e.g., braids, locks, twists) associated with race. This policy also prohibits unlawful discrimination based on the perception that anyone has any of those characteristics or is associated with a person who has or is perceived as having any of those characteristics. This policy applies to all aspects of employment, including but not limited to hiring, job assignment, working conditions, compensation, promotion, benefits, scheduling, training, discipline, and termination. Examples of prohibited conduct include denying a promotion due to age, making jokes about a disability, or using AI tools that disproportionately screen out protected groups (e.g., biased resume screening algorithms). The Company expects all employees to support our equal employment opportunity policy, to take all steps necessary to maintain a workplace free from unlawful discrimination and harassment, and to accommodate others in line with this policy to the fullest extent required by law. For example, the Company will make reasonable accommodations for employees’ observance of religious holidays and practices unless the accommodation would cause an undue hardship (e.g., significant difficulty or expense based on business size, financial resources, or nature of operations) on the Company’s operations. If you desire a religious accommodation, submit a written request to your manager as far in advance as possible (at least 30 days for holidays). You are expected to cooperate in finding solutions, such as trading shifts with coworkers. In compliance with the Americans with Disabilities Act (ADA) and the Pregnant Workers Fairness Act (PWFA), the Company provides reasonable accommodations to qualified individuals with disabilities or known limitations related to pregnancy, childbirth, or related medical conditions, to the fullest extent required by law. The Company may require medical certification of both the disability/limitation and the need for accommodation within 15 days of the request. It is your responsibility to come forward if you need an accommodation. The Company will engage in an interactive process with you to identify possible accommodations that will help you perform the essential functions of your job. Examples include modified work schedules for medical appointments or ergonomic equipment. Denials will be explained in writing with reasons (e.g., undue hardship); appeals must be submitted to Human Resources within 10 days. Under the Texas Responsible Artificial Intelligence Governance Act (TRAIGA), effective January 1, 2026, if the Company uses AI systems in employment decisions (e.g., hiring, performance evaluations, or promotions), it will notify affected individuals, conduct annual bias assessments to prevent disparate impact on protected classes, and maintain records for audits. Report any AI-related concerns to Human Resources without fear of retaliation; investigations will follow the same process as discrimination complaints. The Company prohibits the use of AI in any manner that violates TRAIGA’s prohibitions on discriminatory or harmful AI practices.",
    ],
  },
  {
    id: "2.3",
    sectionId: "2",
    title: "Confidentiality & Non-Disclosure Agreement",
    summary: "Protecting company and customer confidential information.",
    keywords: ["nda", "confidential", "secret"],
    body: [
      "In the course of employment with the Company, employees may have access to “Confidential Information” regarding the Company, which may include its business strategy, future plans, financial information, contracts, suppliers, customers, personnel information, pricing strategies, or other information that the Company considers proprietary and confidential. Maintaining the confidentiality of this information is vital to the Company’s competitive position in the industry and its ability to achieve financial success and stability. Employees must protect this information by safeguarding it when in use, using it only for the business of the Company, and disclosing it only when authorized to do so and only to those who have a legitimate business need to know. This duty of confidentiality applies whether the employee is on or off the Company’s premises, during employment, and even after the end of employment. This duty also applies to communications transmitted by the Company’s electronic systems. See also the Internet, Email, and Computer Use Policy (Section 4.8). Examples of confidential information include customer lists, pricing strategies, employee salaries, and proprietary service methods. Unauthorized disclosure (e.g., sharing with competitors) will result in immediate termination and potential legal action, including injunctions and damages. As a condition of employment, all employees must sign a Non-Disclosure Agreement at the time of hire. Refusal to sign or breach of the agreement voids any employment offer or leads to termination.",
    ],
  },
  {
    id: "2.4",
    sectionId: "2",
    title: "Employment of Minors",
    summary: "Rules for employing minors under federal and state law.",
    body: [
      "The Company strictly adheres to the FLSA’s child labor provisions, which are designed to protect the educational opportunities of youth and prohibit their employment in jobs detrimental to their health and safety. The FLSA sets the minimum age for non-agricultural employment at 14 years, restricts the hours youth under 16 may work (e.g., no more than 3 hours on school days, 8 hours on non-school days, between 7 a.m. and 7 p.m.), and prohibits youth under 18 from being employed in hazardous occupations (e.g., operating heavy machinery or roofing). The FLSA also establishes subminimum wage standards for certain young workers, full-time students, student learners, apprentices, and workers with disabilities; however, employers generally must obtain authorization from the U.S. Department of Labor’s Wage and Hour Division to pay sub-minimum wages. All minor hires require parental consent forms and work permits if under 16. Hours are monitored daily to ensure compliance. Violations by employees (e.g., allowing minors in hazardous areas) will result in discipline up to and including termination.",
    ],
  },
  {
    id: "2.5",
    sectionId: "2",
    title: "Employment of Relatives",
    summary: "When relatives may work together and conflict-of-interest limits.",
    body: [
      "The Company recognizes that the employment of relatives in certain circumstances—such as when they will work in the same department, supervise or manage one another, or have access to confidential or sensitive information regarding the other—can cause problems related to supervision, safety, security, morale, or create conflicts of interest that materially and substantially disrupt operations. When the Company determines any of these problems will be present, it will decline to hire an individual to work in the same department as a relative. Relatives subject to this policy include: father, mother, sister, brother, current spouse or domestic partner, child (natural, foster, or adopted), current mother-in-law, current father-in-law, grandparent, or grandchild. If present employees become relatives during employment, notify Human Resources within seven (7) days so the Company may determine whether a problem exists. If so, the Company will take appropriate steps to resolve the situation, which may include reassignment of one relative (if feasible) or requesting the resignation of one. Undisclosed relationships may lead to disciplinary action, including termination for dishonesty.",
    ],
  },
  {
    id: "2.6",
    sectionId: "2",
    title: "Introductory Period",
    summary: "New-hire introductory period and expectations.",
    body: [
      "The first 90 days of employment are considered an introductory period for all newly hired employees. During this time, you will learn your new responsibilities, become acquainted with fellow employees, and determine whether you are satisfied with the position. Your manager will monitor your performance with weekly check-ins to provide feedback on strengths, areas for improvement, and training needs. Upon completion of the introductory period, your manager will conduct a formal performance review documenting achievements, expected improvements, and any ongoing training requirements. If the Company finds your performance satisfactory and decides to continue your employment, you will be advised in writing. This is also an opportunity for you to make suggestions to improve the Company’s efficiency and operations. Completion of the introductory period does not entitle you to remain employed by the Company for any definite period of time; it allows both you and the Company to evaluate whether you are the right fit for the position. Your status as an at-will employee does not change—the employment relationship may be terminated with or without cause and with or without advance notice at any time by you or the Company. Unsatisfactory performance during this period may result in immediate termination without progressive discipline.",
    ],
  },
  {
    id: "2.7",
    sectionId: "2",
    title: "Personnel Records and Employee References",
    summary: "Personnel files, references, and who can request records.",
    body: [
      "The Company maintains a personnel file and payroll records for each employee as required by law. Personnel files and payroll records are the property of the Company and may not be removed from Company premises without written authorization. Because personnel files and payroll records are confidential, access is restricted. Generally, only those with a legitimate reason to review information in an employee’s file (e.g., managers for performance reviews or legal for investigations) are permitted to do so. Disclosure of personnel information to outside sources will be limited. However, the Company will cooperate with requests from authorized law enforcement or local, state, or federal agencies conducting official investigations and as otherwise legally required. Employees may request to review their own payroll records and/or personnel file by contacting Human Resources with reasonable advance notice (at least seven days). Reviews occur during regular business hours in the presence of an HR representative. No copies of documents in your file may be made, except for documents you have previously signed. You may add written comments to any disputed item in the file within 10 days of review. By policy, the Company will provide only the former or present employee’s dates of employment and position(s) held. Compensation information may also be verified if written authorization is provided by the employee. Unauthorized access or disclosure of personnel information will result in termination.",
    ],
  },
  {
    id: "2.8",
    sectionId: "2",
    title: "Privacy",
    summary: "Privacy expectations at work.",
    body: [
      "The Company is respectful of employee privacy. All employee demographic and personal information will be shared only as required in the normal course of business. Healthcare enrollment information is kept in a separate folder from other human resources forms. Workers’ Compensation information is not considered private healthcare information; however, it will be released only on a need-to-know basis (e.g., to insurers or investigators). The Company does not create or receive any private healthcare information through the normal course of work. If any employee voluntarily shares private healthcare information with a member of management, this information will be kept confidential. If applicable, the Company will establish guidelines to ensure compliance with the Health Insurance Portability and Accountability Act (HIPAA). Examples of privacy breaches include sharing medical conditions without consent. Violations are investigated within 48 hours; confirmed breaches lead to termination.",
    ],
  },
  {
    id: "2.9",
    sectionId: "2",
    title: "Immigration Law Compliance",
    summary: "I-9 / immigration compliance.",
    body: [
      "In compliance with the Immigration Reform and Control Act of 1986, each new employee, as a condition of employment, must complete the Employment Eligibility Verification Form I-9 on the date of hire and present documentation establishing identity and employment eligibility within three business days of the date of hire. Former employees who are rehired must also complete an I-9 form if they have not completed one with the Company within the past three years or if their previous I-9 is no longer valid. Acceptable documents include a U.S. passport, driver’s license with photo, or Social Security card (combined with other required documents). You may raise questions or complaints about immigration law compliance without fear of reprisal; reports are investigated confidentially.",
    ],
  },
  {
    id: "2.10",
    sectionId: "2",
    title: "Political Neutrality",
    summary: "Political activity and neutrality at work.",
    body: [
      "Maintenance of individual freedom and our political institutions necessitates broad-scale participation by citizens in the selection, nomination, and election of public office holders. The Company will not discriminate against any employee because of identification with or support of any lawful political activity. Company employees are entitled to their own personal political positions. The Company will not discriminate against employees based on their lawful political activity engaged in outside of work. However, if you engage in political activity, you must always make it clear that your actions and opinions are your own and not necessarily those of the Company, and that you are not representing the Company. Campaigning on personal time is permitted; using Company resources (including time, equipment, or facilities) for political purposes is prohibited and may lead to discipline.",
    ],
  },
  {
    id: "2.11",
    sectionId: "2",
    title: "Pregnancy, Lactation & Related Accommodations",
    summary: "Pregnancy, lactation, and related accommodations.",
    body: [
      "If you are pregnant, recovering from childbirth, or have a pregnancy-related medical condition, you have the right to breastfeeding and related accommodations in the workplace. Under the Providing Urgent Maternal Protections for Nursing Mothers (“PUMP”) Act and the Pregnant Workers Fairness Act (“PWFA”), employers are required to provide reasonable accommodations to a worker’s known limitations related to pregnancy, childbirth, or related medical conditions. Accommodations include: (a) Reasonable break time for you to express breast milk for your nursing child as needed (up to one year after birth), unpaid and without reduction in compensation or requiring use of paid leave; and (b) A lactation space, other than a bathroom, that is shielded from view and free from intrusion by coworkers and the public (e.g., a locked room with an electrical outlet and chair). Request accommodations in writing to Human Resources or your manager; provide medical certification if requested within 15 days. The Company will engage in an interactive process to determine feasibility, assessing whether an accommodation would cause undue hardship (e.g., significant cost or operational disruption). Denials will be explained in writing with alternatives offered; appeals may be submitted to Human Resources within 10 days. Under the PWFA, your employer cannot require you to accept an accommodation without discussion, force you to take leave if another accommodation would allow you to work, or retaliate against you for requesting an accommodation (e.g., a negative evaluation tied to pregnancy or lactation breaks). Examples of prohibited retaliation include demotion after requesting lactation breaks. Violations are investigated promptly; confirmed cases result in termination of the offender.",
    ],
  },
  {
    id: "2.12",
    sectionId: "2",
    title: "Social Media, Publicity, and Likeness",
    summary: "Social media, publicity, and use of your likeness.",
    body: [
      "The Company occasionally photographs, videos, or otherwise records employees and their completed work projects (“Works”) for use on the Company’s social media pages (Facebook, Instagram, TikTok, etc.), website, marketing materials, job portfolios, newsletters, and other promotional or internal purposes. By accepting and continuing employment with the Company, you grant the Company a perpetual, irrevocable, royalty-free, worldwide, non-exclusive license to use, reproduce, distribute, publicly display, and create derivative works from your name, likeness, voice, image, and biographical information in connection with such materials, without additional compensation, notice, or further consent. You understand that there is generally no reasonable expectation of privacy when performing work in public view, on customer job sites, while wearing Company uniforms, or while operating Company vehicles. However, if you prefer not to have your image or likeness used in Company promotional materials, you may submit a written opt-out request to Human Resources. The Company will make reasonable efforts to honor such requests for future materials, although previously published content may not be recalled or removed. Employees must obtain prior written approval from management before posting any photographs, videos, or information regarding customer properties, completed Works, coworkers, or Company operations on personal social media accounts. This policy protects customer privacy, maintains consistent Company branding, and prevents unauthorized disclosure of confidential information. When using personal social media accounts, employees must:  Not disclose any confidential Company, customer, or employee information.  Not represent themselves as speaking on behalf of the Company unless expressly authorized in writing.  Remain professional and respectful; do not harass, defame, discriminate, or engage in conduct that could harm the Company’s reputation.  Clearly state that any opinions expressed are their own and do not represent the views of the Company. Violations of this policy may result in disciplinary action, up to and including immediate termination, and may subject the employee to civil or legal liability.",
    ],
  },
  {
    id: "3.1",
    sectionId: "3",
    title: "Pay Periods and Paydays",
    summary: "Pay periods and when you get paid.",
    body: [
      "Pay periods are weekly, with paydays on Fridays (or the preceding business day if a holiday falls on Friday). Wages for nonexempt employees are calculated based on hours worked; exempt employees receive their fixed salary. For purposes of unemployment insurance claims under Texas HB 3699 (effective 2026), “last work” refers to the final employer who paid wages to the claimant, excluding non-paying entities (e.g., if you worked for a client but were paid by the Company, the Company is considered the last employer). File claims through the Texas Workforce Commission (TWC) and provide accurate records. The Company responds to claims truthfully. Any disputes must be raised with TWC within the timelines specified in their notice.",
    ],
  },
  {
    id: "3.2",
    sectionId: "3",
    title: "Overtime",
    summary: "When overtime applies and how it is paid.",
    keywords: ["overtime", "ot", "time and a half"],
    body: [
      "Overtime for nonexempt employees is paid at one and one-half (1.5) times the regular rate for all hours worked over 40 in a workweek. The regular rate includes all remuneration (e.g., hourly wage plus any commissions or bonuses). Pre-approval from your manager is required for overtime; unauthorized overtime will be paid but may result in discipline (e.g., a written warning for repeated instances). Example: A technician working 45 hours in a week receives 5 hours at the 1.5x overtime rate. Exempt employees must meet both the salary threshold ($58,656 annually / $1,128 weekly as of 2025, subject to annual adjustments) and the duties test to maintain exempt status. Falsifying hours to claim overtime will result in termination.",
    ],
  },
  {
    id: "3.3",
    sectionId: "3",
    title: "Rest and Meal Periods",
    summary: "Rest breaks and meal periods.",
    keywords: ["break", "lunch", "meal"],
    body: [
      "Nonexempt employees working more than five hours in a day receive a 30-minute unpaid meal period during which no work is performed. Rest breaks of 10–15 minutes are provided as needed and are paid if short in duration. Schedule breaks with your manager to avoid operational disruption. Failure to take scheduled breaks does not entitle you to extra pay. In Texas, state law does not mandate meal or rest breaks, but the Company provides them for health, safety, and productivity reasons in accordance with federal guidelines and best practices.",
    ],
  },
  {
    id: "3.4",
    sectionId: "3",
    title: "Time Cards",
    summary: "Time cards and accurate timekeeping.",
    keywords: ["timecard", "time card", "clock"],
    body: [
      "All nonexempt employees must accurately record time worked daily on the provided time cards or electronic system, including start and end times and meal breaks. Submit time cards by the end of each pay period. Late submissions may delay pay and result in counseling. Falsification of time records (e.g., recording unworked hours) is grounds for immediate termination. Exempt employees are required to report absences only.",
    ],
  },
  {
    id: "3.5",
    sectionId: "3",
    title: "Payroll Deductions",
    summary: "Payroll deductions that may appear on your check.",
    body: [
      "Payroll deductions include all required federal and state taxes, FICA (Social Security and Medicare), and any court-ordered garnishments. Voluntary deductions (e.g., for benefits or uniforms) require your written authorization. Review your pay stubs for accuracy and report any errors to Human Resources within seven (7) days of receipt. Unauthorized deductions will be refunded immediately upon verification.",
    ],
  },
  {
    id: "3.6",
    sectionId: "3",
    title: "Wage Garnishment",
    summary: "How wage garnishments are handled.",
    body: [
      "The Company complies with all court-ordered garnishments (e.g., child support, creditor debts) and will deduct the required amounts until the obligation is satisfied or stopped by court order. Notify Human Resources immediately upon receipt of any garnishment notice so that required employee notifications can be provided. Garnishments do not affect your employment status unless they are related to workplace misconduct.",
    ],
  },
  {
    id: "3.7",
    sectionId: "3",
    title: "Direct Deposit",
    summary: "Direct deposit for pay.",
    body: [
      "Direct deposit is available and encouraged for secure, timely payment. Provide your banking details to Human Resources at the time of hire. Changes to direct deposit information require a written request submitted at least 14 days in advance. If you are not enrolled in direct deposit, paychecks will be issued on payday and should be picked up from the designated location.",
    ],
  },
  {
    id: "4.1",
    sectionId: "4",
    title: "Anti-Harassment and Anti-Discrimination",
    summary: "Zero tolerance for harassment and discrimination; how to report.",
    keywords: ["harassment", "hostile", "report"],
    body: [
      "The Company prohibits harassment or discrimination in all forms, including physical, verbal, visual, or digital conduct that creates a hostile work environment. This policy applies to all work settings: the office, customer job sites, Company vehicles, and virtual interactions. Examples of prohibited conduct include slurs based on race or sex, unwanted touching, offensive emails or text messages, and the use of AI tools that introduce bias (e.g., discriminatory performance scoring). Report incidents immediately to Human Resources or your manager. An anonymous reporting option is available. Investigations begin within 48 hours and include witness interviews and evidence review, with resolution targeted within 14 days. Findings are documented, and corrective action (e.g., training, suspension, or termination) is applied as appropriate. Retaliation (e.g., reduced hours or negative evaluations after reporting) is strictly prohibited and will be investigated separately. Annual anti-harassment and anti-discrimination training is mandatory for all employees; non-attendance will result in disciplinary action. Violations result in progressive discipline up to and including termination.",
    ],
  },
  {
    id: "4.2",
    sectionId: "4",
    title: "Attendance",
    summary: "Attendance expectations and call-in rules.",
    keywords: ["attendance", "late", "absent", "call in", "no call"],
    body: [
      "Regular and punctual attendance is essential to our operations and customer service. Notify your manager by 7:00 a.m. on the day of any absence or tardiness, providing the reason. A doctor’s note is required for illnesses lasting more than two consecutive days. Unexcused absences exceeding three in any 90-day period, or patterns of absence (e.g., frequent Mondays or Fridays), are considered excessive and will lead to progressive discipline. Chronic attendance issues may result in termination. Track your own attendance record; any disputes will be reviewed by Human Resources.",
    ],
  },
  {
    id: "4.3",
    sectionId: "4",
    title: "Discipline and Standards of Conduct",
    summary: "Conduct standards and discipline.",
    body: [
      "The Company expects professional conduct at all times. Violations of Company policies or standards of conduct will lead to progressive discipline: (1) Verbal warning (documented in personnel file), (2) Written warning, (3) Unpaid suspension (1–5 days), and (4) Termination. Serious offenses (e.g., theft, violence, gross insubordination, or safety violations endangering others) warrant immediate termination without prior progressive steps. Standards of conduct include, but are not limited to: honesty, respect for coworkers and customers, no conflicts of interest, and compliance with all policies. You may appeal disciplinary decisions to Human Resources within five (5) business days; the HR decision is final.",
    ],
  },
  {
    id: "4.4",
    sectionId: "4",
    title: "Dress Code",
    summary: "What to wear at work and on the job.",
    body: [
      "Employees must wear clean, professional attire appropriate for their role. Field technicians and service personnel are required to wear Company uniforms and appropriate personal protective equipment (PPE), including safety boots. Office staff should wear business casual attire. Grooming must be hygienic and professional; visible offensive tattoos must be covered. Violations will result in being sent home unpaid to correct the issue; repeated violations will lead to disciplinary action.",
    ],
  },
  {
    id: "4.5",
    sectionId: "4",
    title: "Safety",
    summary: "Safety rules and incident reporting.",
    keywords: ["safety", "injury", "accident"],
    body: [
      "All employees must follow all OSHA regulations and Company safety rules, including the proper use of PPE, safe operation of tools and vehicles, and immediate reporting of hazards or injuries. Report all workplace injuries to your manager immediately—failure to do so may delay Workers’ Compensation benefits. Annual safety training is mandatory. Violations of safety protocols (e.g., bypassing safety guards or failing to use required PPE) will result in disciplinary action up to and including termination.",
    ],
  },
  {
    id: "4.6",
    sectionId: "4",
    title: "Substance Abuse",
    summary: "Drug and alcohol policy.",
    keywords: ["drug", "alcohol", "substance"],
    body: [
      "The use, possession, or being under the influence of alcohol or illegal drugs at work or while performing Company business is strictly prohibited. The Company conducts post-accident and reasonable-suspicion drug and alcohol testing. A positive test result will result in immediate termination. Employees seeking help for substance abuse issues may do so confidentially through the Company’s benefits program or employee assistance resources without fear of immediate reprisal, provided they come forward before a testing event.",
    ],
  },
  {
    id: "4.7",
    sectionId: "4",
    title: "Workplace Searches",
    summary: "When the company may search workplace property.",
    body: [
      "The Company reserves the right to search Company property, including desks, lockers, vehicles, and electronic devices, at any time for safety, security, or policy compliance reasons. Refusal to consent to a reasonable search will result in termination.",
    ],
  },
  {
    id: "4.8",
    sectionId: "4",
    title: "Internet, Email, and Computer Use Policy",
    summary: "Internet, email, and computer use.",
    body: [
      "Company computer systems, email, internet access, and other electronic resources are provided for legitimate business purposes only. Limited personal use is permitted during non-working time provided it does not interfere with work, consume excessive bandwidth, or violate any other policy. All activity on Company systems is subject to monitoring. Prohibited uses include accessing or distributing offensive material, engaging in harassment, downloading unauthorized software, or using systems for personal commercial gain. Violations will result in disciplinary action up to and including termination. See also the Confidentiality policy (Section 2.3).",
    ],
  },
  {
    id: "4.9",
    sectionId: "4",
    title: "Cell Phone Policy",
    summary: "Cell phone use on the job.",
    keywords: ["phone", "cell", "mobile", "texting"],
    body: [
      "Limited personal use of cell phones is permitted during breaks or non-working time, provided it does not disrupt operations or customer service. Cell phone use while operating a Company vehicle or while driving on Company business is strictly prohibited (hands-free only where legally permitted and safe). Violations will result in a warning for the first offense and may lead to termination for repeated or serious violations.",
    ],
  },
  {
    id: "4.10",
    sectionId: "4",
    title: "Company Vehicles",
    summary: "Company vehicles, driving, trackers/cameras, and care of equipment.",
    keywords: ["vehicle", "truck", "van", "driving", "fleet", "tracker", "camera"],
    body: [
      "Only authorized employees with a valid license may operate company vehicles. Personal use is prohibited. Report maintenance issues promptly; record fuel accurately with company fuel cards; lock unattended vehicles. Company vehicles have trackers and cameras. Report accidents immediately; post-accident drug and alcohol testing is required. Refusal or a positive test may lead to discipline up to termination.",
    ],
  },
  {
    id: "4.11",
    sectionId: "4",
    title: "Workplace Violence Prevention & Reporting",
    summary: "Workplace violence prevention and reporting.",
    keywords: ["violence", "threat", "weapon"],
    body: [
      "The Company maintains a zero-tolerance policy for threats, intimidation, or acts of violence in the workplace or while conducting Company business. Report any concerns, threats, or incidents immediately to your manager or Human Resources. You may also contact the Texas Department of Licensing and Regulation (TDLR) hotline at 1-800-452-9595 (available 24/7, anonymous, English/Spanish). All reports will be investigated promptly and thoroughly. Annual workplace violence prevention training is mandatory. Retaliation against anyone who reports in good faith is prohibited. Violations will result in immediate termination and may involve law enforcement.",
    ],
  },
  {
    id: "5.1",
    sectionId: "5",
    title: "Generally",
    summary: "Overview of benefits eligibility.",
    body: [
      "Full-time employees become eligible for most benefits after successful completion of the 90-day introductory period. Part-time employees may be eligible for prorated benefits depending on hours worked and plan rules. The Company notifies employees of any changes to benefits annually or as required by law. Detailed information, including eligibility, costs, and coverage, is provided in the applicable Summary Plan Descriptions (SPDs) or plan documents, which are available from Human Resources. In the event of any conflict between this Manual and the official plan documents, the plan documents control.",
    ],
  },
  {
    id: "5.2",
    sectionId: "5",
    title: "Group Health Insurance",
    summary: "Group health insurance.",
    keywords: ["health", "insurance", "medical"],
    body: [
      "Eligible employees may enroll in the Company’s group health insurance plan. Coverage details, premiums, and enrollment periods are described in the Summary Plan Description provided at hire or upon eligibility. The Company contributes toward premiums as outlined in the plan.",
    ],
  },
  {
    id: "5.3",
    sectionId: "5",
    title: "Group Life Insurance",
    summary: "Group life insurance.",
    body: [
      "Basic group life insurance coverage is provided to eligible employees at no cost. Optional additional coverage for employees and dependents may be available through payroll deduction. Details are in the plan documents available from Human Resources.",
    ],
  },
  {
    id: "5.4",
    sectionId: "5",
    title: "COBRA",
    summary: "COBRA continuation coverage.",
    body: [
      "Upon a qualifying event (e.g., termination of employment, reduction in hours, divorce, or loss of dependent status), eligible employees and dependents may elect to continue group health coverage under COBRA for a limited period by paying the full premium plus any applicable administrative fee. You must notify Human Resources within 60 days of a qualifying event to receive COBRA election information.",
    ],
  },
  {
    id: "5.5",
    sectionId: "5",
    title: "Workers' Compensation",
    summary: "Workers’ compensation for on-the-job injuries.",
    keywords: ["workers comp", "workers compensation", "injury"],
    body: [
      "The Company provides Workers’ Compensation insurance coverage for work-related injuries and illnesses as required by Texas law. Report all injuries immediately to your manager, regardless of severity. There is no retaliation for filing legitimate Workers’ Compensation claims. Benefits and claim procedures are governed by state law and the insurance carrier.",
    ],
  },
  {
    id: "5.6",
    sectionId: "5",
    title: "Social Security Benefits (FICA)",
    summary: "Social Security / FICA.",
    body: [
      "The Company and employees each contribute to Social Security and Medicare (FICA) as required by federal law. Your contributions are matched by the Company. Benefits are administered by the Social Security Administration.",
    ],
  },
  {
    id: "5.7",
    sectionId: "5",
    title: "Unemployment Insurance",
    summary: "Unemployment insurance.",
    body: [
      "The Company pays state unemployment insurance taxes on your behalf. If you become unemployed through no fault of your own and meet eligibility requirements, you may apply for unemployment benefits through the Texas Workforce Commission. The Company reports wages and separations accurately and responds promptly to any claims or requests for information.",
    ],
  },
  {
    id: "5.8",
    sectionId: "5",
    title: "Additional Benefits",
    summary: "Other benefits the company may offer.",
    body: [
      "The Company may offer additional benefits from time to time, such as retirement savings plans (e.g., 401(k)), employee assistance programs, or wellness initiatives. Current offerings and eligibility are communicated by Human Resources and detailed in separate plan documents or summaries. Contact Human Resources for the most up-to-date information on available benefits.",
    ],
  },
  {
    id: "6.1",
    sectionId: "6",
    title: "Generally",
    summary: "How leave requests work — notice, approval, and using paid time first.",
    body: [
      "Planned leaves require written request at least 30 days in advance (emergencies: as soon as known). Leave without approval may be treated as voluntary resignation. Use available sick and vacation before unpaid time off. Outside employment or applying for unemployment during leave may be treated as voluntary resignation. Medical certification may be required. Reinstatement to the same job is not guaranteed except as required by law.",
    ],
  },
  {
    id: "6.2",
    sectionId: "6",
    title: "Sick Days",
    summary: "Five paid sick days per year; unused days are forfeited.",
    keywords: ["sick", "sick day", "illness"],
    body: [
      "Eligible employees are entitled to five paid sick days per year. Sick pay for regular full-time employees is base pay rate times hours the employee would otherwise have worked that day. Unused sick time is forfeited at year end and is not paid out at termination. A doctor’s note is required for absences of more than three consecutive days. Abuse of sick leave may result in discipline.",
    ],
  },
  {
    id: "6.3",
    sectionId: "6",
    title: "Vacation Days",
    summary: "5 days after 1 year, 10 after 3 years, 15 after 5 years.",
    keywords: ["vacation", "pto", "time off"],
    body: [
      "Eligible employees are entitled to five paid vacation days per year after one year, ten days after three years, and fifteen days after five years. Vacation pay for regular full-time employees is base pay rate times hours the employee would otherwise have worked that day. Vacation must be scheduled in advance and approved by your manager. Unused vacation is forfeited at year end and is not paid out at termination unless required by law.",
    ],
  },
  {
    id: "6.4",
    sectionId: "6",
    title: "Holidays",
    summary: "Six paid holidays; part-time pro rata; work-on-holiday pay rules.",
    keywords: ["holiday", "christmas", "thanksgiving"],
    body: [
      "The Company observes New Year’s Day, Memorial Day, Independence Day, Labor Day, Thanksgiving Day, and Christmas Day. Eligible employees receive paid holiday time off. Full-time holiday pay is base pay rate times hours otherwise worked; regular part-time is pro rata. If an eligible nonexempt employee works an approved holiday, they receive holiday pay plus straight-time for hours worked. Weekend holidays are observed on the nearest weekday. Absence without approval the workday before or after a holiday may forfeit holiday pay.",
    ],
  },
  {
    id: "6.5",
    sectionId: "6",
    title: "Family and Medical Leave",
    summary: "Family and Medical Leave (FMLA).",
    keywords: ["fmla", "family leave", "medical leave"],
    body: [
      "Because the Company employs fewer than 50 employees within a 75-mile radius, it is not covered by the federal Family and Medical Leave Act (FMLA). However, the Company complies with the Pregnant Workers Fairness Act (PWFA) and provides reasonable accommodations and leave as required for pregnancy-related conditions (see Section 2.11). Employees needing extended time off for serious health conditions or family caregiving should discuss options with Human Resources; job-protected leave may be available on a case-by-case basis subject to business needs.",
    ],
  },
  {
    id: "6.6",
    sectionId: "6",
    title: "Workers' Compensation Leave",
    summary: "Leave related to workers’ compensation.",
    body: [
      "Employees who suffer a work-related injury or illness may be entitled to job-protected leave while recovering, in accordance with Texas Workers’ Compensation law and the Company’s return-to-work program. Coordinate all leave and return-to-work plans with Human Resources and the claims administrator. The Company will not retaliate against any employee for filing a legitimate Workers’ Compensation claim.",
    ],
  },
  {
    id: "6.7",
    sectionId: "6",
    title: "Bereavement Leave",
    summary: "Up to two paid working days for immediate family.",
    keywords: ["bereavement", "funeral", "death"],
    body: [
      "In the event of a death in the immediate family, employees may have up to two working days with pay at their regular straight-time rate or base salary to handle family affairs and attend the funeral. Immediate family means father, mother, brother, sister, spouse, domestic partner, child, mother-in-law, father-in-law, grandparents, and grandchildren.",
    ],
  },
  {
    id: "6.8",
    sectionId: "6",
    title: "Jury Duty",
    summary: "Bring your summons promptly; report to work when court does not need you.",
    keywords: ["jury"],
    body: [
      "U.S. citizens have a civic obligation to provide jury duty service when called. Bring the jury duty notice as soon as it is received so coverage can be arranged. Call in or report for work on days or parts of days when your presence in court is not required.",
    ],
  },
  {
    id: "6.9",
    sectionId: "6",
    title: "Voting Time",
    summary: "Paid time to vote when you lack two consecutive non-work hours while polls are open.",
    keywords: ["vote", "voting", "election"],
    body: [
      "Employees who are registered voters and who lack two consecutive non-work hours when polls are open may take time off to vote with pay for this purpose in any local, state, or national election.",
    ],
  },
];

const topicById = new Map(HANDBOOK_TOPICS.map((t) => [t.id, t]));
const sectionById = new Map(HANDBOOK_SECTIONS.map((s) => [s.id, s]));

export function getHandbookTopic(id: string): HandbookTopic | undefined {
  return topicById.get(id);
}

export function getHandbookSection(id: string): HandbookSection | undefined {
  return sectionById.get(id);
}

export function searchHandbookTopics(query: string): HandbookTopic[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = HANDBOOK_TOPICS.map((t) => {
    const title = `${t.id} ${t.title}`.toLowerCase();
    const summary = `${t.summary} ${(t.keywords || []).join(" ")}`.toLowerCase();
    const body = t.body.join(" ").toLowerCase();
    const hay = `${title} ${summary} ${body}`;
    if (!tokens.every((tok) => hay.includes(tok))) return null;
    let score = 0;
    for (const tok of tokens) {
      if (title.includes(tok)) score += 8;
      if (summary.includes(tok)) score += 4;
      if (body.includes(tok)) score += 1;
    }
    return { t, score };
  }).filter((x): x is { t: HandbookTopic; score: number } => !!x);
  scored.sort((a, b) => b.score - a.score || a.t.id.localeCompare(b.t.id, undefined, { numeric: true }));
  return scored.map((x) => x.t);
}

export function neighboringTopics(topicId: string): {
  prev: HandbookTopic | null;
  next: HandbookTopic | null;
} {
  const list = HANDBOOK_TOPICS;
  const i = list.findIndex((t) => t.id === topicId);
  if (i < 0) return { prev: null, next: null };
  return { prev: list[i - 1] || null, next: list[i + 1] || null };
}

