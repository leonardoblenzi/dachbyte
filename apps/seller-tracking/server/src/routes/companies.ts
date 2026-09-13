
import { Router } from 'express';
import {
  getCompanies,
  createCompany,
  deleteCompany,
  getCurrentCompany,
  getCompanyUsageSummary,
  updateCurrentCompanyIntegration,
} from '../controllers/companyController';

const router = Router();

router.get('/', getCompanies);
router.get('/:id/usage-summary', getCompanyUsageSummary);
router.get('/current', getCurrentCompany);
router.patch('/current/integration', updateCurrentCompanyIntegration);
router.post('/', createCompany);
router.delete('/:id', deleteCompany);

export default router;
